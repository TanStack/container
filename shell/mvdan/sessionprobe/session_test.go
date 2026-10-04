package sessionprobe

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

func TestIncrementalShellKeepsInterpreterState(t *testing.T) {
	var stdout bytes.Buffer
	runner, err := interp.New(interp.StdIO(nil, &stdout, &stdout))
	if err != nil {
		t.Fatal(err)
	}
	run := func(source string) error {
		t.Helper()
		file, err := syntax.NewParser().Parse(strings.NewReader(source), "prompt")
		if err != nil {
			t.Fatal(err)
		}
		return runner.Run(context.Background(), file)
	}
	if err := run("shopt -s expand_aliases; alias greet='printf alias-'; local_value=kept; function finish { printf function; }"); err != nil {
		t.Fatal(err)
	}
	if err := run("greet; finish; printf ':%s\\n' \"$local_value\""); err != nil {
		t.Fatal(err)
	}
	if got := stdout.String(); got != "alias-function:kept\n" {
		t.Fatalf("state was lost: %q", got)
	}
	stdout.Reset()
	if err := run("set -o pipefail"); err != nil {
		t.Fatal(err)
	}
	if err := run("false | true"); err == nil {
		t.Fatal("pipefail option was lost")
	}
	if err := run("unalias greet; unset -f finish; unset local_value"); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	if err := run("printf '%s\\n' \"$local_value\""); err != nil {
		t.Fatal(err)
	}
	if got := stdout.String(); got != "\n" {
		t.Fatalf("unset did not persist: %q", got)
	}
}
