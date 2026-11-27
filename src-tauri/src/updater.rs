//! Checks for updates, downloads them in the background and installs one on request, for
//! the whole app rather than any one window (Ruling 343). No webview may call the updater.

use std::ffi::OsString;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, Url};
use tauri_plugin_updater::{Update, UpdaterBuilder, UpdaterExt};

/// Sent to every window whenever the state changes.
pub const UPDATE_STATE: &str = "lintel://update-state";
/// Settings has no app commands, so it asks by event: `{ action: "state" | "check" }` (Ruling 245).
pub const UPDATE_REQUEST: &str = "lintel://update-request";

/// Debug builds check only with this set to 1, so dev runs make no network calls.
const TEST_VAR: &str = "LINTEL_UPDATE_TEST";
/// With TEST_VAR, a debug build checks this URL instead, such as a local stub.
const TEST_URL_VAR: &str = "LINTEL_UPDATE_URL";

const CHECKS_OFF: &str = "Update checks are off in development builds.";
const NOT_READY: &str = "No update is ready to install.";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    None,
    Checking,
    Downloading,
    Ready,
    /// From the install request until the relaunch, or back to Ready if the install fails.
    Installing,
    Error,
}

/// What every window shows. `revision` grows with each change, so a window can drop an
/// answer older than an event it already has.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: Status,
    /// The update's version, once one is found.
    pub version: Option<String>,
    pub error: Option<String>,
    pub app_version: String,
    /// Milliseconds since 1970 when the last check ended.
    pub last_checked: Option<u64>,
    pub revision: u64,
}

/// When checks run. Wall-clock time decides, so a night of system sleep counts (Ruling 349).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Schedule {
    /// From launch to the first check.
    pub first: Duration,
    /// How often the clock is looked at.
    pub tick: Duration,
    pub every: Duration,
    /// After a failed check; up to `retries` times in a row, then back to `every`.
    pub retry: Duration,
    pub retries: u32,
}

pub const SCHEDULE: Schedule = Schedule {
    first: Duration::from_secs(10),
    tick: Duration::from_secs(10 * 60),
    every: Duration::from_secs(24 * 60 * 60),
    retry: Duration::from_secs(10 * 60),
    retries: 6,
};

/// The request limits the real feed uses.
#[derive(Clone, PartialEq, Debug)]
pub struct FeedOptions {
    pub check_timeout: Duration,
    /// 30 s is too short for the package itself on a slow line.
    pub download_timeout: Duration,
    /// Replaces the endpoint in tauri.conf.json; debug test runs only.
    pub test_url: Option<Url>,
}

/// What `start` does in this build: whether it checks at all, and against which endpoint.
#[derive(Clone, PartialEq, Debug)]
pub struct Plan {
    pub enabled: bool,
    pub schedule: Schedule,
    pub feed: FeedOptions,
}

impl Plan {
    /// Release builds always check; debug builds only with TEST_VAR=1, and only they may
    /// use TEST_URL_VAR.
    pub fn new(debug_build: bool, env: impl Fn(&str) -> Option<OsString>) -> Self {
        let enabled = !debug_build || env(TEST_VAR).is_some_and(|value| value == "1");
        let test_url = if debug_build && enabled {
            env(TEST_URL_VAR).and_then(|raw| {
                Url::parse(&raw.to_string_lossy())
                    .inspect_err(|err| eprintln!("Ignored {TEST_URL_VAR}: {err}"))
                    .ok()
            })
        } else {
            None
        };
        Self {
            enabled,
            schedule: SCHEDULE,
            feed: FeedOptions {
                check_timeout: Duration::from_secs(30),
                download_timeout: Duration::from_secs(10 * 60),
                test_url,
            },
        }
    }

    pub fn for_this_build(env: impl Fn(&str) -> Option<OsString>) -> Self {
        Self::new(cfg!(debug_assertions), env)
    }
}

/// The update source, so tests can stand in for tauri-plugin-updater.
pub trait Feed: Send + Sync + 'static {
    type Found: Found;
    fn check(&self) -> impl Future<Output = Result<Option<Self::Found>, String>> + Send;
}

/// An update the feed found.
pub trait Found: Send + Sync + 'static {
    fn version(&self) -> String;
    fn download_bytes(&self) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
    /// On Windows this exits the app once the installer starts.
    fn install_bytes(&self, bytes: &[u8]) -> Result<(), String>;
}

/// The steps of an install, for the app to act on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InstallStep {
    /// Files opened from outside wait. Windows lock themselves on hearing the installing
    /// state, which the service sends next.
    Started,
    /// Windows unlock; waiting files open.
    Failed,
    /// Relaunch into the new version.
    Installed,
}

/// The answer to an install request.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Install {
    Installed,
    /// Another request is already installing it; nothing to report.
    Installing,
}

pub struct Hooks {
    pub publish: Box<dyn Fn(&UpdateState) + Send + Sync>,
    pub auto_check: Box<dyn Fn() -> bool + Send + Sync>,
    pub on_install: Box<dyn Fn(InstallStep) + Send + Sync>,
}

struct Ready<U> {
    update: U,
    bytes: Vec<u8>,
}

struct Inner<U> {
    state: UpdateState,
    ready: Option<Ready<U>>,
    /// When the last scheduled check ran, and how long until the next.
    last_check: Option<(SystemTime, Duration)>,
    failures: u32,
}

#[derive(PartialEq, Eq, Debug)]
enum Checked {
    Done,
    Failed,
}

pub struct Service<F: Feed> {
    feed: F,
    enabled: bool,
    schedule: Schedule,
    hooks: Hooks,
    inner: Mutex<Inner<F::Found>>,
    scheduled: AtomicBool,
    stopped: AtomicBool,
}

impl<F: Feed> Service<F> {
    pub fn new(feed: F, app_version: String, enabled: bool, schedule: Schedule, hooks: Hooks) -> Self {
        Self {
            feed,
            enabled,
            schedule,
            hooks,
            inner: Mutex::new(Inner {
                state: UpdateState {
                    status: Status::None,
                    version: None,
                    error: None,
                    app_version,
                    last_checked: None,
                    revision: 0,
                },
                ready: None,
                last_check: None,
                failures: 0,
            }),
            scheduled: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn state(&self) -> UpdateState {
        self.lock().state.clone()
    }

    /// The scheduled check, at wall-clock time `now`: runs when due and auto-check is on.
    pub async fn tick_at(&self, now: SystemTime) {
        let due = self.lock().last_check.is_none_or(|(at, wait)| due(at, wait, now));
        if !due || !(self.hooks.auto_check)() {
            return;
        }
        let failed = self.check().await == Some(Checked::Failed);
        let mut inner = self.lock();
        let wait = if failed && inner.failures < self.schedule.retries {
            inner.failures += 1;
            self.schedule.retry
        } else {
            inner.failures = 0;
            self.schedule.every
        };
        inner.last_check = Some((now, wait));
    }

    /// Ends the schedule at its next tick.
    #[cfg(test)]
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }

    /// Checks, and downloads any update found. None when it did not run: a check already
    /// running, an update already downloaded or installing, or checks off in this build.
    async fn check(&self) -> Option<Checked> {
        if !self.begin_check() {
            return None;
        }
        let outcome = match self.feed.check().await {
            Ok(Some(update)) => {
                let version = update.version();
                self.change(|state| {
                    state.status = Status::Downloading;
                    state.version = Some(version);
                });
                match update.download_bytes().await {
                    Ok(bytes) => Ok(Some(Ready { update, bytes })),
                    Err(err) => Err(format!("Could not download the update: {err}")),
                }
            }
            Ok(None) => Ok(None),
            Err(err) => Err(format!("Could not check for updates: {err}")),
        };
        Some(self.end_check(outcome))
    }

    /// Installs the downloaded update, then asks for the relaunch. A failure leaves it
    /// ready to try again; a second request while one runs is told so.
    pub fn install(&self) -> Result<Install, String> {
        let ready = {
            let mut inner = self.lock();
            if inner.state.status == Status::Installing {
                return Ok(Install::Installing);
            }
            let ready = inner.ready.take().ok_or(NOT_READY)?;
            (self.hooks.on_install)(InstallStep::Started);
            self.apply(&mut inner, |state| state.status = Status::Installing);
            ready
        };
        // Outside the lock: a Linux password prompt must not hold up other windows' queries.
        match ready.update.install_bytes(&ready.bytes) {
            Ok(()) => {
                (self.hooks.on_install)(InstallStep::Installed);
                Ok(Install::Installed)
            }
            Err(err) => {
                let mut inner = self.lock();
                inner.ready = Some(ready);
                self.apply(&mut inner, |state| state.status = Status::Ready);
                drop(inner);
                (self.hooks.on_install)(InstallStep::Failed);
                Err(format!("Could not install the update: {err}"))
            }
        }
    }

    fn begin_check(&self) -> bool {
        let mut inner = self.lock();
        if matches!(
            inner.state.status,
            Status::Checking | Status::Downloading | Status::Ready | Status::Installing
        ) {
            return false;
        }
        if !self.enabled {
            self.apply(&mut inner, |state| {
                state.status = Status::Error;
                state.error = Some(CHECKS_OFF.to_owned());
            });
            return false;
        }
        self.apply(&mut inner, |state| {
            state.status = Status::Checking;
            state.version = None;
            state.error = None;
        });
        true
    }

    fn end_check(&self, outcome: Result<Option<Ready<F::Found>>, String>) -> Checked {
        let mut inner = self.lock();
        let (status, error) = match outcome {
            Ok(Some(ready)) => {
                inner.ready = Some(ready);
                (Status::Ready, None)
            }
            Ok(None) => (Status::None, None),
            Err(err) => (Status::Error, Some(err)),
        };
        self.apply(&mut inner, |state| {
            state.status = status;
            if status != Status::Ready {
                state.version = None;
            }
            state.error = error;
            state.last_checked = Some(now_ms());
        });
        if status == Status::Error {
            Checked::Failed
        } else {
            Checked::Done
        }
    }

    fn change(&self, edit: impl FnOnce(&mut UpdateState)) {
        let mut inner = self.lock();
        self.apply(&mut inner, edit);
    }

    // Published under the lock, so windows hear changes in the order they were made.
    fn apply(&self, inner: &mut Inner<F::Found>, edit: impl FnOnce(&mut UpdateState)) {
        edit(&mut inner.state);
        inner.state.revision += 1;
        (self.hooks.publish)(&inner.state);
    }

    fn lock(&self) -> MutexGuard<'_, Inner<F::Found>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// A last check dated after `now` means the clock was set back since: check now, rather
// than wait for the wrong date to come round again.
fn due(last: SystemTime, wait: Duration, now: SystemTime) -> bool {
    match now.duration_since(last) {
        Ok(since) => since >= wait,
        Err(_) => true,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// Looks at the clock `first` after the start, then every `tick`, until the service is dropped.
pub fn run_schedule<F: Feed>(service: &Arc<Service<F>>, first: Duration, tick: Duration) {
    service.scheduled.store(true, Ordering::SeqCst);
    let service: Weak<Service<F>> = Arc::downgrade(service);
    std::thread::spawn(move || {
        std::thread::sleep(first);
        while let Some(service) = service.upgrade() {
            if service.stopped.load(Ordering::SeqCst) {
                break;
            }
            tauri::async_runtime::block_on(service.tick_at(SystemTime::now()));
            drop(service);
            std::thread::sleep(tick);
        }
    });
}

/// The builder calls the feed makes, behind a trait so a test can record them.
pub trait UpdaterSetup: Sized {
    fn timeout(self, timeout: Duration) -> Self;
    fn endpoints(self, urls: Vec<Url>) -> Result<Self, String>;
    fn on_before_exit(self, hook: impl Fn() + Send + Sync + 'static) -> Self;
}

impl UpdaterSetup for UpdaterBuilder {
    fn timeout(self, timeout: Duration) -> Self {
        UpdaterBuilder::timeout(self, timeout)
    }
    fn endpoints(self, urls: Vec<Url>) -> Result<Self, String> {
        UpdaterBuilder::endpoints(self, urls).map_err(|e| e.to_string())
    }
    fn on_before_exit(self, hook: impl Fn() + Send + Sync + 'static) -> Self {
        UpdaterBuilder::on_before_exit(self, hook)
    }
}

fn configure<R: Runtime, B: UpdaterSetup>(
    builder: B,
    app: &AppHandle<R>,
    options: &FeedOptions,
) -> Result<B, String> {
    let hook = app.clone();
    let builder = builder
        .timeout(options.check_timeout)
        // Windows only: its installer ends the process without RunEvent::Exit.
        .on_before_exit(move || before_windows_install(&hook));
    match &options.test_url {
        Some(url) => builder.endpoints(vec![url.clone()]),
        None => Ok(builder),
    }
}

const MAIN_THREAD_WAIT: Duration = Duration::from_secs(5);

/// What exit would have saved. The session is saved already, by the quit rounds.
pub fn before_windows_install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let saved = run_and_wait(
        |job| app.run_on_main_thread(job).map_err(|err| err.to_string()),
        move || {
            crate::session::save_geometry_now(&handle);
            // The plugin's own hook, which this one replaces.
            handle.cleanup_before_exit();
        },
        MAIN_THREAD_WAIT,
    );
    if !saved {
        eprintln!("Window sizes were not saved before the update: the app did not answer");
    }
}

// The save runs on the main thread: off it, each window read waits for the main thread,
// which may be waiting for a lock the save holds (Ruling 351). False if it did not finish.
fn run_and_wait(
    dispatch: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), String>,
    work: impl FnOnce() + Send + 'static,
    wait: Duration,
) -> bool {
    let (done, finished) = mpsc::channel();
    let job: Box<dyn FnOnce() + Send> = Box::new(move || {
        work();
        let _ = done.send(());
    });
    dispatch(job).is_ok() && finished.recv_timeout(wait).is_ok()
}

/// The real feed: tauri-plugin-updater with the endpoint in tauri.conf.json.
pub struct PluginFeed<R: Runtime> {
    app: AppHandle<R>,
    options: FeedOptions,
}

impl<R: Runtime> Feed for PluginFeed<R> {
    type Found = Update;

    fn check(&self) -> impl Future<Output = Result<Option<Update>, String>> + Send {
        let app = self.app.clone();
        let options = self.options.clone();
        async move {
            let builder = configure(app.updater_builder(), &app, &options)?;
            let updater = builder.build().map_err(|e| e.to_string())?;
            let found = updater.check().await.map_err(|e| e.to_string())?;
            Ok(found.map(|mut update| {
                update.timeout = Some(options.download_timeout);
                update
            }))
        }
    }
}

impl Found for Update {
    fn version(&self) -> String {
        self.version.clone()
    }

    async fn download_bytes(&self) -> Result<Vec<u8>, String> {
        self.download(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())
    }

    fn install_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        self.install(bytes).map_err(|e| e.to_string())
    }
}

pub type AppUpdates<R> = Arc<Service<PluginFeed<R>>>;

/// Starts the service: managed for the commands, answering Settings, and checking on schedule.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    start_from_env(app, |name| std::env::var_os(name));
}

fn start_from_env<R: Runtime>(
    app: &AppHandle<R>,
    env: impl Fn(&str) -> Option<OsString>,
) -> AppUpdates<R> {
    let plan = Plan::for_this_build(env);
    start_with(app, plan, run_schedule, AppHandle::request_restart)
}

fn start_with<R, S>(
    app: &AppHandle<R>,
    plan: Plan,
    schedule: S,
    restart: impl Fn(&AppHandle<R>) + Send + Sync + 'static,
) -> AppUpdates<R>
where
    R: Runtime,
    S: FnOnce(&AppUpdates<R>, Duration, Duration),
{
    app.manage(InstallLock::default());
    let (publisher, settings, installer) = (app.clone(), app.clone(), app.clone());
    let hooks = Hooks {
        publish: Box::new(move |state| {
            if let Err(err) = publisher.emit(UPDATE_STATE, state) {
                eprintln!("Could not send the update state: {err}");
            }
        }),
        auto_check: Box::new(move || crate::settings::auto_check(&settings)),
        on_install: Box::new(move |step| on_install_step(&installer, step, &restart)),
    };
    let feed = PluginFeed {
        app: app.clone(),
        options: plan.feed.clone(),
    };
    let version = app.package_info().version.to_string();
    let service = Arc::new(Service::new(feed, version, plan.enabled, plan.schedule, hooks));
    app.manage(Arc::clone(&service));
    answer_settings(app, Arc::clone(&service));
    if plan.enabled {
        schedule(&service, plan.schedule.first, plan.schedule.tick);
    }
    service
}

/// Set while an update installs, so the app does not quit under it.
#[derive(Default)]
struct InstallLock(AtomicBool);

fn on_install_step<R: Runtime>(
    app: &AppHandle<R>,
    step: InstallStep,
    restart: &dyn Fn(&AppHandle<R>),
) {
    let lock = &app.state::<InstallLock>().0;
    match step {
        InstallStep::Started => {
            lock.store(true, Ordering::SeqCst);
            crate::open_queue::hold(app);
        }
        InstallStep::Failed => {
            lock.store(false, Ordering::SeqCst);
            crate::open_queue::release(app);
        }
        InstallStep::Installed => restart(app),
    }
}

/// Whether to refuse a quit the user asked for, such as closing the last window, while an
/// update installs. The relaunch and Lintel's own exits name a `code`, and are not refused.
pub fn holds_exit<R: Runtime>(app: &AppHandle<R>, code: Option<i32>) -> bool {
    code.is_none()
        && app
            .try_state::<InstallLock>()
            .is_some_and(|lock| lock.0.load(Ordering::SeqCst))
}

#[derive(Deserialize)]
struct UpdateRequest {
    action: String,
}

fn answer_settings<R: Runtime, F: Feed>(app: &AppHandle<R>, service: Arc<Service<F>>) {
    let handle = app.clone();
    app.listen(UPDATE_REQUEST, move |event| {
        let Ok(request) = serde_json::from_str::<UpdateRequest>(event.payload()) else {
            eprintln!("Ignored a malformed {UPDATE_REQUEST}: {}", event.payload());
            return;
        };
        match request.action.as_str() {
            "state" => {
                if let Err(err) = handle.emit_to(crate::SETTINGS, UPDATE_STATE, service.state()) {
                    eprintln!("Could not answer Settings: {err}");
                }
            }
            "check" => {
                let service = Arc::clone(&service);
                tauri::async_runtime::spawn(async move { service.check().await });
            }
            other => eprintln!("Ignored the update request {other}"),
        }
    });
}

/// The state now, for a window that has just opened.
#[tauri::command]
pub fn update_state<R: Runtime>(app: AppHandle<R>) -> UpdateState {
    app.state::<AppUpdates<R>>().state()
}

/// Installs the downloaded update and relaunches; on Windows its installer relaunches.
/// The caller must run every window's quit prompts first: this command cannot tell.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<Install, String> {
    let service = Arc::clone(app.state::<AppUpdates<R>>().inner());
    tauri::async_runtime::spawn_blocking(move || service.install())
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use std::time::Instant;

    type Script = Arc<Mutex<VecDeque<Result<Option<&'static str>, &'static str>>>>;
    type Shared<T> = Arc<Mutex<T>>;

    /// Answers each check with the next scripted result; downloads fail for "bad".
    #[derive(Default, Clone)]
    struct Stub {
        script: Script,
        checks: Shared<usize>,
        installs: Shared<Vec<Vec<u8>>>,
        install_fails: Shared<bool>,
        /// While set, an install waits for a message on it.
        install_waits: Shared<Option<mpsc::Receiver<()>>>,
    }

    struct StubUpdate {
        version: &'static str,
        stub: Stub,
    }

    impl Feed for Stub {
        type Found = StubUpdate;
        fn check(&self) -> impl Future<Output = Result<Option<StubUpdate>, String>> + Send {
            *self.checks.lock().unwrap() += 1;
            let next = self.script.lock().unwrap().pop_front().unwrap_or(Ok(None));
            let stub = self.clone();
            async move {
                next.map(|found| found.map(|version| StubUpdate { version, stub }))
                    .map_err(str::to_owned)
            }
        }
    }

    impl Found for StubUpdate {
        fn version(&self) -> String {
            self.version.to_owned()
        }
        async fn download_bytes(&self) -> Result<Vec<u8>, String> {
            match self.version {
                "bad" => Err("offline".to_owned()),
                version => Ok(version.as_bytes().to_vec()),
            }
        }
        fn install_bytes(&self, bytes: &[u8]) -> Result<(), String> {
            let wait = self.stub.install_waits.lock().unwrap().take();
            if let Some(wait) = wait {
                wait.recv().unwrap();
            }
            if *self.stub.install_fails.lock().unwrap() {
                return Err("denied".to_owned());
            }
            self.stub.installs.lock().unwrap().push(bytes.to_vec());
            Ok(())
        }
    }

    struct Probe {
        stub: Stub,
        heard: Shared<Vec<UpdateState>>,
        steps: Shared<Vec<InstallStep>>,
    }

    fn service_with(
        script: &[Result<Option<&'static str>, &'static str>],
        enabled: bool,
        auto_check: bool,
    ) -> (Service<Stub>, Probe) {
        let stub = Stub::default();
        stub.script.lock().unwrap().extend(script.iter().copied());
        let (heard, steps) = (Shared::<Vec<UpdateState>>::default(), Shared::<Vec<InstallStep>>::default());
        let (log, step_log) = (heard.clone(), steps.clone());
        let hooks = Hooks {
            publish: Box::new(move |state: &UpdateState| log.lock().unwrap().push(state.clone())),
            auto_check: Box::new(move || auto_check),
            on_install: Box::new(move |step| step_log.lock().unwrap().push(step)),
        };
        let service = Service::new(stub.clone(), "0.1.0".to_owned(), enabled, SCHEDULE, hooks);
        (service, Probe { stub, heard, steps })
    }

    impl Probe {
        fn checks(&self) -> usize {
            *self.stub.checks.lock().unwrap()
        }
        fn statuses(&self) -> Vec<(Status, Option<String>)> {
            let heard = self.heard.lock().unwrap();
            heard.iter().map(|s| (s.status, s.version.clone())).collect()
        }
        fn steps(&self) -> Vec<InstallStep> {
            self.steps.lock().unwrap().clone()
        }
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    const MIN: Duration = Duration::from_secs(60);
    const HOUR: Duration = Duration::from_secs(60 * 60);

    fn t0() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    #[test]
    fn no_update_leaves_none() {
        let (service, probe) = service_with(&[Ok(None)], true, true);
        run(service.tick_at(t0()));
        assert_eq!(probe.checks(), 1);
        assert_eq!(probe.statuses(), [(Status::Checking, None), (Status::None, None)]);
        let state = service.state();
        assert_eq!(state.app_version, "0.1.0");
        assert!(state.last_checked.is_some());
    }

    #[test]
    fn an_update_is_downloaded_then_ready_with_its_version() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.tick_at(t0()));
        let v = Some("0.1.1".to_owned());
        assert_eq!(
            probe.statuses(),
            [(Status::Checking, None), (Status::Downloading, v.clone()), (Status::Ready, v)]
        );
        let heard = probe.heard.lock().unwrap();
        assert_eq!(heard.iter().map(|s| s.revision).collect::<Vec<_>>(), [1, 2, 3]);
    }

    #[test]
    fn after_a_check_the_next_waits_24_hours_by_the_wall_clock() {
        let (service, probe) = service_with(&[Ok(None), Ok(None)], true, true);
        run(service.tick_at(t0()));
        run(service.tick_at(t0() + 10 * MIN));
        run(service.tick_at(t0() + 23 * HOUR));
        assert_eq!(probe.checks(), 1);
        // A night of system sleep passes between two ticks.
        run(service.tick_at(t0() + 24 * HOUR));
        assert_eq!(probe.checks(), 2);
    }

    #[test]
    fn a_failed_check_says_so_and_is_tried_again_10_minutes_later() {
        let (service, probe) = service_with(&[Err("offline"), Ok(Some("0.1.1"))], true, true);
        run(service.tick_at(t0()));
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some("Could not check for updates: offline"));

        run(service.tick_at(t0() + 9 * MIN));
        assert_eq!(probe.checks(), 1);
        run(service.tick_at(t0() + 10 * MIN));
        assert_eq!(probe.checks(), 2);
        assert_eq!(service.state().status, Status::Ready);
        assert_eq!(service.state().error, None);
    }

    #[test]
    fn after_6_failed_retries_the_next_check_waits_24_hours() {
        let (service, probe) = service_with(&[Err("offline"); 9], true, true);
        let mut at = t0();
        for _ in 0..7 {
            run(service.tick_at(at));
            at += 10 * MIN;
        }
        assert_eq!(probe.checks(), 7, "the first check and 6 retries");
        run(service.tick_at(at));
        run(service.tick_at(t0() + 60 * MIN + 23 * HOUR));
        assert_eq!(probe.checks(), 7);
        run(service.tick_at(t0() + 60 * MIN + 24 * HOUR));
        assert_eq!(probe.checks(), 8);
        run(service.tick_at(t0() + 70 * MIN + 24 * HOUR));
        assert_eq!(probe.checks(), 9, "a new failure is retried again");
    }

    #[test]
    fn a_failed_download_says_so_without_a_version() {
        let (service, _) = service_with(&[Ok(Some("bad"))], true, true);
        run(service.check());
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some("Could not download the update: offline"));
        assert_eq!(state.version, None);
        assert_eq!(service.install(), Err(NOT_READY.to_owned()));
    }

    #[test]
    fn auto_check_off_makes_no_scheduled_check_but_check_now_still_runs() {
        let (service, probe) = service_with(&[Ok(None)], true, false);
        run(service.tick_at(t0()));
        assert_eq!(probe.checks(), 0);
        assert!(probe.heard.lock().unwrap().is_empty());
        run(service.check());
        assert_eq!(probe.checks(), 1);
    }

    #[test]
    fn a_ready_update_is_not_checked_again() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.tick_at(t0()));
        run(service.tick_at(t0() + 25 * HOUR));
        assert_eq!(probe.checks(), 1);
        assert_eq!(probe.heard.lock().unwrap().len(), 3);
        assert_eq!(service.state().status, Status::Ready);
    }

    #[test]
    fn an_install_locks_the_windows_installs_the_bytes_then_relaunches() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], true, true);
        assert_eq!(service.install(), Err(NOT_READY.to_owned()));
        run(service.check());

        assert_eq!(service.install(), Ok(Install::Installed));

        assert_eq!(*probe.stub.installs.lock().unwrap(), [b"0.1.1".to_vec()]);
        assert_eq!(probe.steps(), [InstallStep::Started, InstallStep::Installed]);
        assert_eq!(service.state().status, Status::Installing);
    }

    #[test]
    fn a_failed_install_unlocks_the_windows_and_keeps_the_update_ready() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.check());
        *probe.stub.install_fails.lock().unwrap() = true;

        assert_eq!(service.install(), Err("Could not install the update: denied".to_owned()));
        assert_eq!(probe.steps(), [InstallStep::Started, InstallStep::Failed]);
        let statuses = probe.statuses();
        assert_eq!(
            statuses[statuses.len() - 2..].iter().map(|s| s.0).collect::<Vec<_>>(),
            [Status::Installing, Status::Ready]
        );

        *probe.stub.install_fails.lock().unwrap() = false;
        assert_eq!(service.install(), Ok(Install::Installed));
    }

    #[test]
    fn a_second_install_request_while_one_runs_is_told_it_is_installing() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.check());
        let (go, wait) = mpsc::channel();
        *probe.stub.install_waits.lock().unwrap() = Some(wait);
        let service = Arc::new(service);
        let first = {
            let service = Arc::clone(&service);
            std::thread::spawn(move || service.install())
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.state().status != Status::Installing && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }

        assert_eq!(service.install(), Ok(Install::Installing));
        run(service.check());
        assert_eq!(probe.checks(), 1, "no check while installing");

        go.send(()).unwrap();
        assert_eq!(first.join().unwrap(), Ok(Install::Installed));
        assert_eq!(probe.stub.installs.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_disabled_service_never_calls_the_feed_and_says_why() {
        let (service, probe) = service_with(&[Ok(Some("0.1.1"))], false, true);
        run(service.tick_at(t0()));
        run(service.check());
        assert_eq!(probe.checks(), 0);
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some(CHECKS_OFF));
    }

    fn env(vars: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        let vars = vars.to_vec();
        move |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    const STUB: &str = "http://127.0.0.1:8765/latest.json";

    #[test]
    fn debug_builds_check_only_when_the_test_variable_is_1() {
        assert!(Plan::new(false, env(&[])).enabled);
        assert!(Plan::new(false, env(&[(TEST_VAR, "0")])).enabled);
        assert!(!Plan::new(true, env(&[])).enabled);
        assert!(!Plan::new(true, env(&[(TEST_VAR, "0")])).enabled);
        assert!(!Plan::new(true, env(&[(TEST_VAR, "")])).enabled);
        assert!(Plan::new(true, env(&[(TEST_VAR, "1")])).enabled);
        assert_eq!(TEST_VAR, "LINTEL_UPDATE_TEST");
    }

    #[test]
    fn this_test_build_is_a_debug_build_so_it_does_not_check_unless_asked() {
        const { assert!(cfg!(debug_assertions)) };
        assert!(!Plan::for_this_build(env(&[])).enabled);
        assert!(!Plan::for_this_build(env(&[(TEST_URL_VAR, STUB)])).enabled);
        assert!(Plan::for_this_build(env(&[(TEST_VAR, "1")])).enabled);
    }

    #[test]
    fn only_a_debug_test_run_may_point_at_another_endpoint() {
        let stub = Some(Url::parse(STUB).unwrap());
        let both = [(TEST_VAR, "1"), (TEST_URL_VAR, STUB)];
        assert_eq!(Plan::new(true, env(&both)).feed.test_url, stub);
        assert_eq!(Plan::new(false, env(&both)).feed.test_url, None, "release ignores it");
        assert_eq!(Plan::new(true, env(&[(TEST_URL_VAR, STUB)])).feed.test_url, None);
        assert_eq!(Plan::new(false, env(&[(TEST_URL_VAR, STUB)])).feed.test_url, None);
        assert_eq!(TEST_URL_VAR, "LINTEL_UPDATE_URL");
    }

    #[test]
    fn checks_10_s_after_launch_then_daily_retrying_failures_with_request_limits() {
        let plan = Plan::new(false, env(&[]));
        assert_eq!(
            plan.schedule,
            Schedule {
                first: Duration::from_secs(10),
                tick: 10 * MIN,
                every: 24 * HOUR,
                retry: 10 * MIN,
                retries: 6,
            }
        );
        assert_eq!(plan.feed.check_timeout, Duration::from_secs(30));
        assert_eq!(plan.feed.download_timeout, 10 * MIN);
    }

    #[test]
    fn the_schedule_looks_at_the_clock_each_tick_and_stops_with_the_service() {
        let (service, probe) = service_with(&[Ok(None)], true, true);
        let service = Arc::new(service);
        run_schedule(&service, Duration::ZERO, Duration::from_millis(10));
        let deadline = Instant::now() + Duration::from_secs(5);
        while probe.checks() == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(probe.checks(), 1);
        service.lock().last_check = None;
        while probe.checks() == 1 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(probe.checks(), 2, "a due check runs at the next tick");
        drop(service);
        std::thread::sleep(Duration::from_millis(100));
        let checks = probe.checks();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(probe.checks(), checks);
    }

    #[test]
    fn a_last_check_dated_after_now_counts_as_due() {
        let (service, probe) = service_with(&[Ok(None); 4], true, true);
        // The clock was a year ahead at the check, then put right.
        run(service.tick_at(t0() + 365 * 24 * HOUR));
        run(service.tick_at(t0()));
        assert_eq!(probe.checks(), 2);
        run(service.tick_at(t0() + 10 * MIN));
        assert_eq!(probe.checks(), 2);
        run(service.tick_at(t0() + 24 * HOUR));
        assert_eq!(probe.checks(), 3);
        assert!(due(t0() + HOUR, 24 * HOUR, t0()));
        assert!(!due(t0(), 24 * HOUR, t0() + 23 * HOUR));
    }

    #[test]
    fn the_first_check_comes_at_first_not_after_a_tick() {
        let (service, probe) = service_with(&[Ok(None)], true, true);
        let service = Arc::new(service);
        run_schedule(&service, Duration::ZERO, HOUR);
        let deadline = Instant::now() + Duration::from_secs(5);
        while probe.checks() == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        service.stop();
        assert_eq!(probe.checks(), 1);
    }

    #[test]
    fn the_windows_hook_waits_for_the_main_thread_to_finish_the_save() {
        let saved = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&saved);
        let finished = run_and_wait(
            |job| {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    job();
                });
                Ok(())
            },
            move || flag.store(true, Ordering::SeqCst),
            Duration::from_secs(5),
        );
        assert!(finished);
        assert!(saved.load(Ordering::SeqCst), "returned before the save ran");

        let dropped = run_and_wait(|_job| Ok(()), || {}, Duration::from_secs(5));
        assert!(!dropped);
        let refused = run_and_wait(|_job| Err("no".to_owned()), || {}, Duration::from_secs(5));
        assert!(!refused);
    }

    /// Records the builder calls `configure` makes, and keeps the before-exit hook.
    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        hook: Option<Box<dyn Fn() + Send + Sync>>,
    }

    impl UpdaterSetup for Recorder {
        fn timeout(mut self, timeout: Duration) -> Self {
            self.calls.push(format!("timeout {timeout:?}"));
            self
        }
        fn endpoints(mut self, urls: Vec<Url>) -> Result<Self, String> {
            let urls: Vec<&str> = urls.iter().map(Url::as_str).collect();
            self.calls.push(format!("endpoints {}", urls.join(" ")));
            Ok(self)
        }
        fn on_before_exit(mut self, hook: impl Fn() + Send + Sync + 'static) -> Self {
            self.calls.push("on_before_exit".to_owned());
            self.hook = Some(Box::new(hook));
            self
        }
    }

    mod in_app {
        use super::*;
        use crate::session::test_support::{geometry_app, note_size, saved_size};
        use crate::test_support::temp_dir;
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use tauri::test::{mock_builder, MockRuntime};

        fn app_with(service: Arc<Service<Stub>>) -> tauri::App<MockRuntime> {
            let app = mock_builder().build(crate::test_support::mock_context()).unwrap();
            app.manage(Arc::clone(&service));
            answer_settings(app.handle(), service);
            app
        }

        #[test]
        fn a_window_opened_later_sees_ready_by_asking() {
            let (service, _) = service_with(&[Ok(Some("0.1.1"))], true, true);
            let service = Arc::new(service);
            run(service.check());
            let app = app_with(Arc::clone(&service));
            let state = app.state::<Arc<Service<Stub>>>().state();
            assert_eq!(state.status, Status::Ready);
            assert_eq!(state.version.as_deref(), Some("0.1.1"));
        }

        #[test]
        fn settings_asks_by_event_and_hears_the_state() {
            let (service, _) = service_with(&[Ok(Some("0.1.1"))], true, true);
            let service = Arc::new(service);
            run(service.check());
            let app = app_with(service);
            let heard = Shared::<Vec<String>>::default();
            let log = heard.clone();
            app.listen_any(UPDATE_STATE, move |e| log.lock().unwrap().push(e.payload().to_owned()));

            app.emit(UPDATE_REQUEST, serde_json::json!({ "action": "state" }))
                .unwrap();

            let heard = heard.lock().unwrap();
            assert_eq!(heard.len(), 1);
            let state: serde_json::Value = serde_json::from_str(&heard[0]).unwrap();
            assert_eq!(state["status"], "ready");
            assert_eq!(state["version"], "0.1.1");
            assert_eq!(state["appVersion"], "0.1.0");
        }

        #[test]
        fn check_now_by_event_runs_a_check() {
            let (service, probe) = service_with(&[Ok(None)], true, true);
            let app = app_with(Arc::new(service));
            app.emit(UPDATE_REQUEST, serde_json::json!({ "action": "check" }))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while probe.checks() == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(probe.checks(), 1);
        }

        fn plain_app() -> tauri::App<MockRuntime> {
            mock_builder()
                .manage(Mutex::new(crate::open_queue::OpenQueue::default()))
                .build(crate::test_support::mock_context())
                .unwrap()
        }

        type Restarts = Shared<usize>;
        type Started = (
            AppUpdates<MockRuntime>,
            Vec<(Duration, Duration)>,
            Restarts,
            tauri::App<MockRuntime>,
        );

        fn start_recorded(plan: Plan) -> Started {
            let app = plain_app();
            let mut scheduled = Vec::new();
            let restarts = Restarts::default();
            let counted = restarts.clone();
            let service = start_with(
                app.handle(),
                plan,
                |_, first, tick| scheduled.push((first, tick)),
                move |_| *counted.lock().unwrap() += 1,
            );
            (service, scheduled, restarts, app)
        }

        #[test]
        fn start_schedules_checks_only_when_the_plan_allows_them() {
            let (service, scheduled, _, _) = start_recorded(Plan::new(true, env(&[])));
            assert!(scheduled.is_empty());
            assert!(!service.enabled);

            let both = [(TEST_VAR, "1"), (TEST_URL_VAR, STUB)];
            let plan = Plan::new(true, env(&both));
            let (service, scheduled, _, _) = start_recorded(plan.clone());
            assert_eq!(scheduled, [(Duration::from_secs(10), 10 * MIN)]);
            assert!(service.enabled);
            assert_eq!(service.schedule, plan.schedule);
            assert_eq!(service.feed.options, plan.feed);
        }

        #[test]
        fn install_steps_hold_opened_files_and_quits_then_let_them_go() {
            let (service, _, restarts, app) = start_recorded(Plan::new(true, env(&[])));
            let queue = || crate::open_queue::lock(&app.state::<Mutex<crate::open_queue::OpenQueue>>()).is_held();
            let handle = app.handle();
            assert!(!holds_exit(handle, None));

            (service.hooks.on_install)(InstallStep::Started);
            assert!(queue());
            assert!(holds_exit(handle, None), "closing the last window waits");
            assert!(!holds_exit(handle, Some(0)), "Lintel's own exit is not held");
            assert!(!holds_exit(handle, Some(tauri::RESTART_EXIT_CODE)), "nor the relaunch");

            (service.hooks.on_install)(InstallStep::Failed);
            assert!(!queue());
            assert!(!holds_exit(handle, None));
            assert_eq!(*restarts.lock().unwrap(), 0);
        }

        #[test]
        fn a_finished_install_relaunches_through_the_restarter() {
            let (service, _, restarts, _app) = start_recorded(Plan::new(true, env(&[])));
            (service.hooks.on_install)(InstallStep::Installed);
            assert_eq!(*restarts.lock().unwrap(), 1);
        }

        #[test]
        fn start_checks_only_if_this_build_and_the_environment_allow_it() {
            let app = plain_app();
            let service = start_from_env(app.handle(), env(&[]));
            assert!(!service.enabled, "a debug build makes no network calls");
            assert!(!service.scheduled.load(Ordering::SeqCst));

            let app = plain_app();
            let service = start_from_env(app.handle(), env(&[(TEST_VAR, "1"), (TEST_URL_VAR, STUB)]));
            service.stop();
            assert!(service.enabled);
            assert!(service.scheduled.load(Ordering::SeqCst));
            assert_eq!(service.schedule, SCHEDULE);
            assert_eq!(service.feed.options.test_url, Some(Url::parse(STUB).unwrap()));
        }

        #[test]
        fn the_feed_sets_the_check_timeout_endpoint_and_windows_hook() {
            let dir = temp_dir("feed-hook");
            let state = dir.join("window-state.json");
            let app = geometry_app(&state);
            let options = FeedOptions {
                check_timeout: Duration::from_secs(30),
                download_timeout: 10 * MIN,
                test_url: Some(Url::parse(STUB).unwrap()),
            };

            let recorded = configure(Recorder::default(), app.handle(), &options).unwrap();

            assert_eq!(
                recorded.calls,
                [
                    "timeout 30s".to_owned(),
                    "on_before_exit".to_owned(),
                    format!("endpoints {STUB}"),
                ]
            );
            let without = FeedOptions { test_url: None, ..options };
            let recorded_without = configure(Recorder::default(), app.handle(), &without).unwrap();
            assert!(!recorded_without.calls.iter().any(|c| c.starts_with("endpoints")));

            // The hook Windows runs before its installer ends the process.
            note_size(app.handle(), "main", (640, 480));
            (recorded.hook.unwrap())();
            assert_eq!(saved_size(&state, "main"), Some((640, 480)));
            std::fs::remove_dir_all(&dir).unwrap();
        }

        /// Serves `/latest.json` naming an update at `/package`, which never answers.
        fn hanging_server() -> String {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let package = format!("{base}/package");
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let package = package.clone();
                    std::thread::spawn(move || {
                        let mut line = String::new();
                        let _ = BufReader::new(&stream).read_line(&mut line);
                        if !line.contains("/latest.json") {
                            std::thread::sleep(Duration::from_secs(60));
                            return;
                        }
                        let target = tauri_plugin_updater::target().unwrap();
                        let body = serde_json::json!({
                            "version": "9.9.9",
                            "platforms": { target: { "url": package, "signature": "none" } }
                        })
                        .to_string();
                        let mut stream = stream;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                    });
                }
            });
            base
        }

        const CHECK_LIMIT: Duration = Duration::from_millis(300);
        const DOWNLOAD_LIMIT: Duration = Duration::from_millis(700);

        fn feed_against(url: String) -> PluginFeed<MockRuntime> {
            let mut context = crate::test_support::mock_context();
            context.config_mut().plugins.0.insert(
                "updater".into(),
                serde_json::json!({ "pubkey": "none", "endpoints": ["https://example.invalid/latest.json"] }),
            );
            let app = mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let options = FeedOptions {
                check_timeout: CHECK_LIMIT,
                download_timeout: DOWNLOAD_LIMIT,
                test_url: Some(Url::parse(&url).unwrap()),
            };
            PluginFeed {
                app: app.handle().clone(),
                options,
            }
        }

        // On a thread, so a request that never gives up fails the test instead of hanging it.
        fn within<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
            let (done, result) = mpsc::channel();
            std::thread::spawn(move || done.send(work()));
            result
                .recv_timeout(Duration::from_secs(20))
                .expect("the request should have given up at its timeout")
        }

        #[test]
        fn a_check_that_gets_no_answer_gives_up_at_its_timeout() {
            let base = hanging_server();
            let feed = feed_against(format!("{base}/hang"));
            let result = within(move || run(feed.check()).map(|found| found.is_some()));
            assert!(result.is_err(), "{result:?}");
        }

        #[test]
        fn a_download_that_stalls_gives_up_at_its_own_timeout() {
            let base = hanging_server();
            let feed = feed_against(format!("{base}/latest.json"));
            let update = within(move || run(feed.check())).unwrap().expect("an update");
            assert_eq!(update.timeout, Some(DOWNLOAD_LIMIT), "its own limit, not the check's");
            let result = within(move || run(update.download_bytes()).map(|bytes| bytes.len()));
            assert!(result.is_err(), "{result:?}");
        }
    }

    #[test]
    fn windows_and_settings_use_the_same_event_names() {
        assert_eq!(UPDATE_STATE, "lintel://update-state");
        assert_eq!(UPDATE_REQUEST, "lintel://update-request");
        let updater = include_str!("../../src/lib/os/updater.ts");
        assert!(updater.contains("export const UPDATE_STATE = 'lintel://update-state';"));
        assert!(updater.contains("export const UPDATE_REQUEST = 'lintel://update-request';"));
    }
}
