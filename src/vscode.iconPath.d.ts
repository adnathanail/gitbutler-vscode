// `IconPath` as later versions of `@types/vscode` define it. The proposed API in
// `vscode.proposed.scmHistoryProvider.d.ts` uses it, but `@types/vscode` is pinned to the oldest
// supported VS Code (`engines.vscode`), which predates it.
declare module "vscode" {
  export type IconPath = Uri | { light: Uri; dark: Uri } | ThemeIcon;
}
