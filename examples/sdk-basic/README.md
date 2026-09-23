# Public SDK workspace example

Copy this directory outside the sandbox repository. Install matching local core
and runtime tarballs in the copied directory, then run:

```sh
SDK_TARBALL=/absolute/path/to/tanstack-browser-sandbox-experimental.tgz
RUNTIME_TARBALL=/absolute/path/to/tanstack-browser-sandbox-runtime-experimental.tgz
npm install "$SDK_TARBALL" "$RUNTIME_TARBALL" --ignore-scripts
npm start
```

Open the printed localhost URL. Edit the message, run it, and check the output
and preview. Save, reload the host page, resume, then run again. The saved files
live in localStorage for that owner origin. The host uses ports 4173 (owner)
and 4174 (preview), so saved files remain available after restarting it.

Choose different ports with `OWNER_PORT=4273 PREVIEW_PORT=4274 npm start`.
Keep the same owner port to recover saved files. A busy port fails startup
instead of silently changing origins. For automation, use
`OWNER_PORT=0 PREVIEW_PORT=0 npm start` or
`startExample({ownerPort:0,previewPort:0})` for temporary ports.

The Node host serves static files only. Guest Node-style code runs in the
browser. The example uses public SDK imports and `prepareRuntimeAssets` to assemble
installed compiler dependencies and runtime assets into a fresh hosting directory.
The separate preview origin uses the package's hosting contract.
Generated assets are placed in a new temporary directory and are not deleted by
the example. Stop the host with Ctrl+C.

This is a small file/edit/run/preview/resume example, not proof of Vite, Start,
package installation, Safari support or production security. Do not use
sensitive projects or credentials. Check the installed package for its project
license. Private `0.0.0` candidates are not public releases.
