// The package ships no types and there is no @types package (Ruling 63).
declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';

  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  const taskLists: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default taskLists;
}
