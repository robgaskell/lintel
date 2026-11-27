//! Checks for updates, downloads them in the background and installs one on request, for
//! the whole app rather than any one window (Ruling 343). No webview may call the updater.

use std::ffi::OsString;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Sent to every window whenever the state changes.
pub const UPDATE_STATE: &str = "lintel://update-state";
/// Settings has no app commands, so it asks by event: `{ action: "state" | "check" }` (Ruling 245).
pub const UPDATE_REQUEST: &str = "lintel://update-request";

const FIRST_CHECK: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
// 30 s is too short for the package itself on a slow line.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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

struct Ready<U> {
    update: U,
    bytes: Vec<u8>,
}

struct Inner<U> {
    state: UpdateState,
    ready: Option<Ready<U>>,
}

type Publish = Box<dyn Fn(&UpdateState) + Send + Sync>;
type AutoCheck = Box<dyn Fn() -> bool + Send + Sync>;

pub struct Service<F: Feed> {
    feed: F,
    enabled: bool,
    publish: Publish,
    auto_check: AutoCheck,
    inner: Mutex<Inner<F::Found>>,
}

impl<F: Feed> Service<F> {
    pub fn new(
        feed: F,
        app_version: String,
        enabled: bool,
        publish: impl Fn(&UpdateState) + Send + Sync + 'static,
        auto_check: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            feed,
            enabled,
            publish: Box::new(publish),
            auto_check: Box::new(auto_check),
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
            }),
        }
    }

    pub fn state(&self) -> UpdateState {
        self.lock().state.clone()
    }

    /// The scheduled check: skipped while Settings > Updates has auto-check off.
    pub async fn tick(&self) {
        if (self.auto_check)() {
            self.check().await;
        }
    }

    /// Checks, and downloads any update found. A check already running, or an update
    /// already downloaded, makes this do nothing.
    pub async fn check(&self) {
        if !self.begin_check() {
            return;
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
                    Err(err) => Err(err),
                }
            }
            Ok(None) => Ok(None),
            Err(err) => Err(err),
        };
        self.end_check(outcome);
    }

    /// Installs the downloaded update. A failure leaves it ready to try again.
    pub fn install(&self) -> Result<(), String> {
        // Taken out first: a Linux password prompt must not hold up other windows' queries.
        let ready = self.lock().ready.take().ok_or(NOT_READY)?;
        let installed = ready.update.install_bytes(&ready.bytes);
        if installed.is_err() {
            self.lock().ready = Some(ready);
        }
        installed
    }

    fn begin_check(&self) -> bool {
        let mut inner = self.lock();
        if matches!(
            inner.state.status,
            Status::Checking | Status::Downloading | Status::Ready
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

    fn end_check(&self, outcome: Result<Option<Ready<F::Found>>, String>) {
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
    }

    fn change(&self, edit: impl FnOnce(&mut UpdateState)) {
        let mut inner = self.lock();
        self.apply(&mut inner, edit);
    }

    // Published under the lock, so windows hear changes in the order they were made.
    fn apply(&self, inner: &mut Inner<F::Found>, edit: impl FnOnce(&mut UpdateState)) {
        edit(&mut inner.state);
        inner.state.revision += 1;
        (self.publish)(&inner.state);
    }

    fn lock(&self) -> MutexGuard<'_, Inner<F::Found>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// Release builds always check; debug builds only when asked to.
pub fn checks_allowed(debug_build: bool, test_var: Option<OsString>) -> bool {
    !debug_build || test_var.is_some_and(|value| value == "1")
}

/// Checks `first` after the start, then every `every`, until the service is dropped.
pub fn schedule<F: Feed>(service: &Arc<Service<F>>, first: Duration, every: Duration) {
    let service: Weak<Service<F>> = Arc::downgrade(service);
    std::thread::spawn(move || {
        std::thread::sleep(first);
        while let Some(service) = service.upgrade() {
            tauri::async_runtime::block_on(service.tick());
            drop(service);
            std::thread::sleep(every);
        }
    });
}

/// The real feed: tauri-plugin-updater with the endpoint in tauri.conf.json.
pub struct PluginFeed<R: Runtime> {
    app: AppHandle<R>,
    test_url: Option<Url>,
}

impl<R: Runtime> Feed for PluginFeed<R> {
    type Found = Update;

    fn check(&self) -> impl Future<Output = Result<Option<Update>, String>> + Send {
        let app = self.app.clone();
        let test_url = self.test_url.clone();
        async move {
            let hook = app.clone();
            let mut builder = app
                .updater_builder()
                .timeout(CHECK_TIMEOUT)
                // Windows only: its installer exits the app without RunEvent::Exit.
                .on_before_exit(move || crate::session::save_geometry_now(&hook));
            if let Some(url) = test_url {
                builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
            }
            let updater = builder.build().map_err(|e| e.to_string())?;
            let found = updater.check().await.map_err(|e| e.to_string())?;
            Ok(found.map(|mut update| {
                update.timeout = Some(DOWNLOAD_TIMEOUT);
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
    let enabled = checks_allowed(cfg!(debug_assertions), std::env::var_os(TEST_VAR));
    let test_url = test_url(cfg!(debug_assertions), enabled);
    let (publisher, settings) = (app.clone(), app.clone());
    let service = Arc::new(Service::new(
        PluginFeed {
            app: app.clone(),
            test_url,
        },
        app.package_info().version.to_string(),
        enabled,
        move |state| {
            if let Err(err) = publisher.emit(UPDATE_STATE, state) {
                eprintln!("Could not send the update state: {err}");
            }
        },
        move || crate::settings::auto_check(&settings),
    ));
    app.manage(Arc::clone(&service));
    answer_settings(app, Arc::clone(&service));
    if enabled {
        schedule(&service, FIRST_CHECK, CHECK_EVERY);
    }
}

fn test_url(debug_build: bool, enabled: bool) -> Option<Url> {
    if !(debug_build && enabled) {
        return None;
    }
    let raw = std::env::var(TEST_URL_VAR).ok()?;
    Url::parse(&raw)
        .inspect_err(|err| eprintln!("Ignored {TEST_URL_VAR}: {err}"))
        .ok()
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

/// Installs the downloaded update, then relaunches; Windows' installer relaunches instead.
/// The window calls this only once every window's unsaved-changes prompts have passed.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let service = Arc::clone(app.state::<AppUpdates<R>>().inner());
    tauri::async_runtime::spawn_blocking(move || service.install())
        .await
        .map_err(|err| err.to_string())??;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Instant;

    type Script = Arc<Mutex<VecDeque<Result<Option<&'static str>, &'static str>>>>;

    /// Answers each check with the next scripted result; downloads fail for "bad".
    #[derive(Default)]
    struct Stub {
        script: Script,
        checks: Arc<Mutex<usize>>,
        installs: Arc<Mutex<Vec<Vec<u8>>>>,
        install_fails: Arc<Mutex<bool>>,
    }

    struct StubUpdate {
        version: &'static str,
        installs: Arc<Mutex<Vec<Vec<u8>>>>,
        install_fails: Arc<Mutex<bool>>,
    }

    impl Feed for Stub {
        type Found = StubUpdate;
        fn check(&self) -> impl Future<Output = Result<Option<StubUpdate>, String>> + Send {
            *self.checks.lock().unwrap() += 1;
            let next = self.script.lock().unwrap().pop_front().unwrap_or(Ok(None));
            let (installs, install_fails) = (self.installs.clone(), self.install_fails.clone());
            async move {
                next.map(|found| {
                    found.map(|version| StubUpdate {
                        version,
                        installs,
                        install_fails,
                    })
                })
                .map_err(str::to_owned)
            }
        }
    }

    impl Found for StubUpdate {
        fn version(&self) -> String {
            self.version.to_owned()
        }
        fn download_bytes(&self) -> impl Future<Output = Result<Vec<u8>, String>> + Send {
            let version = self.version;
            async move {
                match version {
                    "bad" => Err("download failed".to_owned()),
                    _ => Ok(version.as_bytes().to_vec()),
                }
            }
        }
        fn install_bytes(&self, bytes: &[u8]) -> Result<(), String> {
            if *self.install_fails.lock().unwrap() {
                return Err("install failed".to_owned());
            }
            self.installs.lock().unwrap().push(bytes.to_vec());
            Ok(())
        }
    }

    type Heard = Arc<Mutex<Vec<UpdateState>>>;

    fn service_with(
        script: &[Result<Option<&'static str>, &'static str>],
        enabled: bool,
        auto_check: bool,
    ) -> (Service<Stub>, Heard, Stub) {
        let stub = Stub::default();
        stub.script.lock().unwrap().extend(script.iter().copied());
        let probe = Stub {
            script: stub.script.clone(),
            checks: stub.checks.clone(),
            installs: stub.installs.clone(),
            install_fails: stub.install_fails.clone(),
        };
        let heard = Heard::default();
        let log = heard.clone();
        let service = Service::new(
            stub,
            "0.1.0".to_owned(),
            enabled,
            move |state| log.lock().unwrap().push(state.clone()),
            move || auto_check,
        );
        (service, heard, probe)
    }

    fn statuses(heard: &Heard) -> Vec<(Status, Option<String>)> {
        heard
            .lock()
            .unwrap()
            .iter()
            .map(|s| (s.status, s.version.clone()))
            .collect()
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn no_update_leaves_none() {
        let (service, heard, stub) = service_with(&[Ok(None)], true, true);
        run(service.tick());
        assert_eq!(*stub.checks.lock().unwrap(), 1);
        assert_eq!(
            statuses(&heard),
            [(Status::Checking, None), (Status::None, None)]
        );
        let state = service.state();
        assert_eq!(state.app_version, "0.1.0");
        assert!(state.last_checked.is_some());
    }

    #[test]
    fn an_update_is_downloaded_then_ready_with_its_version() {
        let (service, heard, _) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.tick());
        let v = Some("0.1.1".to_owned());
        assert_eq!(
            statuses(&heard),
            [
                (Status::Checking, None),
                (Status::Downloading, v.clone()),
                (Status::Ready, v)
            ]
        );
        let revisions: Vec<u64> = heard.lock().unwrap().iter().map(|s| s.revision).collect();
        assert_eq!(revisions, [1, 2, 3]);
    }

    #[test]
    fn a_failed_check_is_an_error_and_the_next_interval_tries_again() {
        let (service, heard, stub) = service_with(&[Err("offline"), Ok(Some("0.1.1"))], true, true);
        run(service.tick());
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some("offline"));

        run(service.tick());
        assert_eq!(*stub.checks.lock().unwrap(), 2);
        assert_eq!(service.state().status, Status::Ready);
        assert_eq!(service.state().error, None);
        assert_eq!(heard.lock().unwrap().len(), 5);
    }

    #[test]
    fn a_failed_download_is_an_error_without_a_version() {
        let (service, _, _) = service_with(&[Ok(Some("bad"))], true, true);
        run(service.check());
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some("download failed"));
        assert_eq!(state.version, None);
        assert_eq!(service.install(), Err(NOT_READY.to_owned()));
    }

    #[test]
    fn auto_check_off_makes_no_scheduled_check_but_check_now_still_runs() {
        let (service, heard, stub) = service_with(&[Ok(None)], true, false);
        run(service.tick());
        assert_eq!(*stub.checks.lock().unwrap(), 0);
        assert!(heard.lock().unwrap().is_empty());
        run(service.check());
        assert_eq!(*stub.checks.lock().unwrap(), 1);
    }

    #[test]
    fn a_ready_update_is_not_checked_again() {
        let (service, heard, stub) = service_with(&[Ok(Some("0.1.1"))], true, true);
        run(service.tick());
        run(service.tick());
        assert_eq!(*stub.checks.lock().unwrap(), 1);
        assert_eq!(heard.lock().unwrap().len(), 3);
        assert_eq!(service.state().status, Status::Ready);
    }

    #[test]
    fn installs_the_downloaded_bytes_and_keeps_the_update_ready_if_that_fails() {
        let (service, _, stub) = service_with(&[Ok(Some("0.1.1"))], true, true);
        assert_eq!(service.install(), Err(NOT_READY.to_owned()));
        run(service.check());

        *stub.install_fails.lock().unwrap() = true;
        assert_eq!(service.install(), Err("install failed".to_owned()));
        assert_eq!(service.state().status, Status::Ready);

        *stub.install_fails.lock().unwrap() = false;
        assert_eq!(service.install(), Ok(()));
        assert_eq!(*stub.installs.lock().unwrap(), [b"0.1.1".to_vec()]);
    }

    #[test]
    fn a_disabled_service_never_calls_the_feed_and_says_why() {
        let (service, heard, stub) = service_with(&[Ok(Some("0.1.1"))], false, true);
        run(service.tick());
        run(service.check());
        assert_eq!(*stub.checks.lock().unwrap(), 0);
        let state = service.state();
        assert_eq!(state.status, Status::Error);
        assert_eq!(state.error.as_deref(), Some(CHECKS_OFF));
        assert_eq!(heard.lock().unwrap().len(), 2);
    }

    #[test]
    fn debug_builds_check_only_when_the_test_variable_is_1() {
        assert!(checks_allowed(false, None));
        assert!(checks_allowed(false, Some("0".into())));
        assert!(!checks_allowed(true, None));
        assert!(!checks_allowed(true, Some("0".into())));
        assert!(!checks_allowed(true, Some("".into())));
        assert!(checks_allowed(true, Some("1".into())));
        assert_eq!(TEST_VAR, "LINTEL_UPDATE_TEST");
    }

    #[test]
    fn only_a_debug_test_run_may_point_at_another_endpoint() {
        std::env::set_var(TEST_URL_VAR, "http://127.0.0.1:8765/latest.json");
        assert_eq!(test_url(false, true), None);
        assert_eq!(test_url(true, false), None);
        assert_eq!(
            test_url(true, true).map(String::from),
            Some("http://127.0.0.1:8765/latest.json".to_owned())
        );
        std::env::remove_var(TEST_URL_VAR);
    }

    #[test]
    fn checks_10_s_after_launch_then_every_24_h_with_a_30_s_request_limit() {
        assert_eq!(FIRST_CHECK, Duration::from_secs(10));
        assert_eq!(CHECK_EVERY, Duration::from_secs(86_400));
        assert_eq!(CHECK_TIMEOUT, Duration::from_secs(30));
    }

    #[test]
    fn the_schedule_retries_after_an_error_and_stops_with_the_service() {
        let (service, _, stub) = service_with(&[Err("offline"), Ok(Some("0.1.1"))], true, true);
        let service = Arc::new(service);
        schedule(&service, Duration::ZERO, Duration::from_millis(20));
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.state().status != Status::Ready && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(service.state().status, Status::Ready);
        assert_eq!(*stub.checks.lock().unwrap(), 2);
        drop(service);
        std::thread::sleep(Duration::from_millis(100));
        let checks = *stub.checks.lock().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(*stub.checks.lock().unwrap(), checks);
    }

    mod in_app {
        use super::*;
        use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

        fn app_with(service: Arc<Service<Stub>>) -> tauri::App<MockRuntime> {
            let app = mock_builder().build(mock_context(noop_assets())).unwrap();
            app.manage(Arc::clone(&service));
            answer_settings(app.handle(), service);
            app
        }

        #[test]
        fn a_window_opened_later_sees_ready_by_asking() {
            let (service, _, _) = service_with(&[Ok(Some("0.1.1"))], true, true);
            let service = Arc::new(service);
            run(service.check());
            let app = app_with(Arc::clone(&service));
            let state = app.state::<Arc<Service<Stub>>>().state();
            assert_eq!(state.status, Status::Ready);
            assert_eq!(state.version.as_deref(), Some("0.1.1"));
        }

        #[test]
        fn settings_asks_by_event_and_hears_the_state() {
            let (service, _, _) = service_with(&[Ok(Some("0.1.1"))], true, true);
            let service = Arc::new(service);
            run(service.check());
            let app = app_with(service);
            let heard = Arc::new(Mutex::new(Vec::<String>::new()));
            let log = heard.clone();
            app.listen_any(UPDATE_STATE, move |e| {
                log.lock().unwrap().push(e.payload().to_owned())
            });

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
            let (service, _, stub) = service_with(&[Ok(None)], true, true);
            let app = app_with(Arc::new(service));
            app.emit(UPDATE_REQUEST, serde_json::json!({ "action": "check" }))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while *stub.checks.lock().unwrap() == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(*stub.checks.lock().unwrap(), 1);
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
