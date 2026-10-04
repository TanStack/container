# Native release example sources

These snapshots contain the tracked files from five Router examples at
`b839f47027956f71ed2db51f436701801addb1d6`. Binary files are base64 encoded.
The upstream MIT license is included unchanged. `manifest.json` binds the
source snapshots and the original npm locks in `fixtures/native-real-*`.

The release reader rejects changed snapshots, license text, lockfiles, source
paths and root dependency declarations. The browser runner tests the original
files, not copies edited to fit the runtime.

To capture another revision, use a Router checkout with no edits to the five
examples. Choose a new output directory so the current accepted snapshots are
not overwritten:

```sh
node --input-type=module -e "import {captureNativeExampleSources} from './scripts/capture-native-example-sources.mjs'; captureNativeExampleSources('/absolute/path/to/router', process.cwd(), '/absolute/path/to/new/snapshots')"
```

Review the source revision and lock root declarations before replacing these
inputs. A changed source snapshot or lock requires a new full browser batch,
it cannot inherit acceptance from the previous revision.

The earlier suite at `6f882b7` remains in
`reports/inputs/native-examples-6f882b7`, with the original snapshots, license,
manifests and locks. Pass that directory as the root to
`readPinnedNativeExamples` to replay it. Its earlier failed results remain
recorded, updating the launch inputs does not resolve those failures.
