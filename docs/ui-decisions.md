# UI design decisions

The interface is organized around three tasks: defining rules, inspecting decisions, and managing mailbox connections.

- **Rules** is the default workspace. A desktop navigation rail becomes a bottom tab bar on mobile.
- The editor keeps the classification prompt freeform and makes possible answers structured: choice name, meaning, and a Gmail label from the selected mailbox.
- **No match** is always visible and cannot be removed. It never applies a label.
- The test panel uses unsaved settings and clearly distinguishes a predicted label from an applied label. Changing the rule or input invalidates an earlier test result.
- Batch editing uses **Choose changes → Map labels → Review**. All fields default to Keep current. Different prompt variants require overwrite acknowledgement; each mailbox retains its own explicit label mappings.
- Updates are atomic and use optimistic version checks. A conflict leaves all selected rules unchanged.
- Status and error messages use text as well as color. Keyboard-accessible native dialogs and form controls support the primary workflows.
- Activity identifies each rule and version separately, with exact outcomes for labels, no match, uncertainty, skipped work, and failures.

Claude CLI was consulted during design using a product-only brief with tool access disabled. Its recommendations informed the restrained palette, navigation, separate test panel, and staged batch review. The implementation retained freeform prompts and atomic updates to match the application's data model.
