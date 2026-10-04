package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

type limitedBuffer struct{ bytes.Buffer }

type shellVariables map[string]expand.Variable

func (vars shellVariables) Get(name string) expand.Variable { return vars[name] }
func (vars shellVariables) Each(visit func(string, expand.Variable) bool) {
	for name, value := range vars {
		if !visit(name, value) {
			return
		}
	}
}

type shellSnapshot struct {
	Version   int               `json:"version"`
	Variables shellVariables    `json:"variables"`
	Functions map[string]string `json:"functions,omitempty"`
}

var sessionRunner *interp.Runner
var sessionCancel context.CancelFunc
var sessionMu sync.Mutex

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1048576 {
		return 0, fmt.Errorf("shell output limit exceeded")
	}
	return b.Buffer.Write(p)
}
func (b *limitedBuffer) WriteString(s string) (int, error) { return b.Write([]byte(s)) }
func (b *limitedBuffer) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{b}, r)
}

func promise(fn func() (any, error)) js.Value {
	cb := js.FuncOf(func(_ js.Value, a []js.Value) any {
		go func() {
			v, e := fn()
			if errors.Is(e, io.ErrClosedPipe) {
				a[1].Invoke(map[string]any{"code": "EPIPE", "message": e.Error()})
			} else if e != nil {
				a[1].Invoke(e.Error())
			} else {
				a[0].Invoke(v)
			}
		}()
		return nil
	})
	p := js.Global().Get("Promise").New(cb)
	cb.Release()
	return p
}

type bridgeError struct {
	code    string
	message string
}

func (e bridgeError) Error() string { return e.message }

func await(p js.Value) (js.Value, error) {
	type result struct {
		v js.Value
		e error
	}
	ch := make(chan result, 1)
	ok := js.FuncOf(func(_ js.Value, a []js.Value) any { ch <- result{v: a[0]}; return nil })
	bad := js.FuncOf(func(_ js.Value, a []js.Value) any {
		value := a[0]
		message := value.String()
		code := ""
		if value.Type() == js.TypeObject {
			if field := value.Get("message"); field.Type() == js.TypeString {
				message = field.String()
			}
			if field := value.Get("code"); field.Type() == js.TypeString {
				code = field.String()
			}
		}
		ch <- result{e: bridgeError{code: code, message: message}}
		return nil
	})
	p.Call("then", ok, bad)
	r := <-ch
	ok.Release()
	bad.Release()
	return r.v, r.e
}
func array(b []byte) js.Value {
	v := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(v, b)
	return v
}
func raw(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}
func jsCall(name string, args ...any) (v js.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return await(js.Global().Get("shellFS").Call(name, args...))
}

type file struct{ fd int }

func (f *file) Read(b []byte) (int, error) {
	v, e := jsCall("read", f.fd, len(b))
	if e != nil {
		return 0, e
	}
	n := js.CopyBytesToGo(b, v)
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}
func (f *file) Write(b []byte) (int, error) {
	v, e := jsCall("write", f.fd, array(b))
	if e != nil {
		return 0, e
	}
	return v.Int(), nil
}
func (f *file) Close() error { _, e := jsCall("close", f.fd); return e }

type info struct {
	NameValue string `json:"name"`
	SizeValue int64  `json:"size"`
	ModeValue uint32 `json:"mode"`
	Directory bool   `json:"isDir"`
}

func (i info) Name() string { return i.NameValue }
func (i info) Size() int64  { return i.SizeValue }
func (i info) Mode() fs.FileMode {
	m := fs.FileMode(i.ModeValue & 0777)
	if i.Directory {
		m |= fs.ModeDir
	}
	return m
}
func (i info) ModTime() time.Time { return time.Time{} }
func (i info) IsDir() bool        { return i.Directory }
func (i info) Sys() any           { return nil }
func resolve(ctx context.Context, p string) string {
	if path.IsAbs(p) {
		return p
	}
	return path.Join(interp.HandlerCtx(ctx).Dir, p)
}

type streamReader struct{ pending []byte }

func (r *streamReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if len(r.pending) == 0 {
		value, err := await(js.Global().Call("shellReadStdin"))
		if err != nil {
			return 0, err
		}
		if value.IsNull() {
			return 0, io.EOF
		}
		r.pending = raw(value)
		if len(r.pending) == 0 {
			return 0, io.ErrNoProgress
		}
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

type streamWriter struct{ name string }

func (w streamWriter) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > 16384 {
			n = 16384
		}
		_, err := await(js.Global().Call(w.name, array(p[:n])))
		if err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}
func run(script string, timeout int, cwd string, environment map[string]string, stdin []byte, streaming bool, priorState string, persistent bool) (any, error) {
	if persistent && !streaming {
		return nil, fmt.Errorf("persistent shell requires streaming I/O")
	}
	if persistent && priorState != "" {
		return nil, fmt.Errorf("persistent shell cannot restore a one-shot snapshot")
	}
	var ctx context.Context
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	defer cancel()
	if persistent {
		sessionMu.Lock()
		sessionCancel = cancel
		sessionMu.Unlock()
		defer func() {
			sessionMu.Lock()
			sessionCancel = nil
			sessionMu.Unlock()
		}()
	}
	var out, errout limitedBuffer
	var priorFunctions map[string]string
	var input io.Reader = bytes.NewReader(stdin)
	var output io.Writer = &out
	var errorOutput io.Writer = &errout
	if streaming {
		input = &streamReader{}
		output = streamWriter{"shellWriteStdout"}
		errorOutput = streamWriter{"shellWriteStderr"}
	}
	exec := func(next interp.ExecHandlerFunc) interp.ExecHandlerFunc {
		return func(ctx context.Context, args []string) error {
			hc := interp.HandlerCtx(ctx)
			read := js.FuncOf(func(_ js.Value, _ []js.Value) any {
				return promise(func() (any, error) {
					b := make([]byte, 16384)
					n, e := hc.Stdin.Read(b)
					if e == io.EOF {
						return nil, nil
					}
					if e != nil {
						return nil, e
					}
					return array(b[:n]), nil
				})
			})
			writer := func(w io.Writer) js.Func {
				return js.FuncOf(func(_ js.Value, a []js.Value) any {
					b := raw(a[0])
					return promise(func() (any, error) { _, e := w.Write(b); return nil, e })
				})
			}
			write := writer(hc.Stdout)
			stderr := writer(hc.Stderr)
			defer read.Release()
			defer write.Release()
			defer stderr.Release()
			env := map[string]string{}
			hc.Env.Each(func(k string, v expand.Variable) bool {
				if v.Exported {
					env[k] = v.String()
				}
				return true
			})
			aj, _ := json.Marshal(args)
			ej, _ := json.Marshal(env)
			controller := js.Global().Get("AbortController").New()
			done := make(chan struct{})
			go func() {
				select {
				case <-ctx.Done():
					controller.Call("abort")
				case <-done:
				}
			}()
			v, e := await(js.Global().Call("shellSpawn", string(aj), hc.Dir, string(ej), read, write, stderr, controller.Get("signal")))
			close(done)
			if e != nil {
				var transport bridgeError
				if errors.As(e, &transport) && transport.code == "ENOENT" {
					_, _ = fmt.Fprintf(hc.Stderr, "%s: command not found\n", args[0])
					return interp.ExitStatus(127)
				}
				return e
			}
			if v.Int() == 0 {
				return nil
			}
			return interp.ExitStatus(v.Int())
		}
	}
	env := shellVariables{
		"PATH": {Set: true, Exported: true, Kind: expand.String, Str: "/bin:/project/node_modules/.bin"},
		"HOME": {Set: true, Exported: true, Kind: expand.String, Str: "/project"},
	}
	if priorState != "" {
		if len(priorState) > 65536 {
			return nil, fmt.Errorf("shell state exceeds limit")
		}
		var snapshot shellSnapshot
		if err := json.Unmarshal([]byte(priorState), &snapshot); err != nil {
			return nil, err
		}
		if snapshot.Version != 1 || snapshot.Variables == nil || len(snapshot.Variables) > 512 {
			return nil, fmt.Errorf("invalid shell state")
		}
		env = snapshot.Variables
		priorFunctions = snapshot.Functions
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env[key] = expand.Variable{Set: true, Exported: true, Kind: expand.String, Str: environment[key]}
	}
	createRunner := func() (*interp.Runner, error) {
		return interp.New(func(r *interp.Runner) error {
			v, e := jsCall("stat", cwd, true)
			if e != nil {
				return e
			}
			var i info
			if e = json.Unmarshal([]byte(v.String()), &i); e != nil {
				return e
			}
			if !i.Directory {
				return fmt.Errorf("cwd is not a directory")
			}
			r.Dir = cwd
			return nil
		}, interp.Env(env), interp.StdIO(input, output, errorOutput), interp.ExecHandlers(exec),
			interp.OpenHandler(func(ctx context.Context, p string, flags int, mode os.FileMode) (io.ReadWriteCloser, error) {
				v, e := jsCall("open", resolve(ctx, p), flags, int(mode))
				if e != nil {
					return nil, e
				}
				return &file{v.Int()}, nil
			}),
			interp.StatHandler(func(ctx context.Context, p string, follow bool) (fs.FileInfo, error) {
				v, e := jsCall("stat", resolve(ctx, p), follow)
				if e != nil {
					return nil, e
				}
				var i info
				e = json.Unmarshal([]byte(v.String()), &i)
				return i, e
			}),
			interp.ReadDirHandler2(func(ctx context.Context, p string) ([]fs.DirEntry, error) {
				v, e := jsCall("readdir", resolve(ctx, p))
				if e != nil {
					return nil, e
				}
				var entries []info
				if e = json.Unmarshal([]byte(v.String()), &entries); e != nil {
					return nil, e
				}
				r := []fs.DirEntry{}
				for _, i := range entries {
					r = append(r, fs.FileInfoToDirEntry(i))
				}
				return r, nil
			}),
		)
	}
	var runner *interp.Runner
	var e error
	if persistent && sessionRunner != nil {
		runner = sessionRunner
	} else {
		runner, e = createRunner()
		if e == nil && persistent {
			sessionRunner = runner
		}
	}
	if e != nil {
		return nil, e
	}
	if len(priorFunctions) > 128 {
		return nil, fmt.Errorf("too many shell functions")
	}
	if len(priorFunctions) > 0 {
		runner.Reset()
		runner.Funcs = make(map[string]*syntax.Stmt, len(priorFunctions))
		for name, source := range priorFunctions {
			body, err := syntax.NewParser().Parse(strings.NewReader(source), "shell-function")
			if err != nil || len(body.Stmts) != 1 {
				return nil, fmt.Errorf("invalid shell function: %s", name)
			}
			runner.Funcs[name] = body.Stmts[0]
		}
	}
	tree, e := syntax.NewParser().Parse(strings.NewReader(script), "probe.sh")
	if e != nil {
		_, _ = fmt.Fprintln(errorOutput, e)
		return map[string]any{"stdout": array(out.Bytes()), "stderr": array(errout.Bytes()), "code": 2, "error": e.Error(), "cwd": runner.Dir}, nil
	}
	unsupportedFD := ""
	syntax.Walk(tree, func(node syntax.Node) bool {
		redirect, ok := node.(*syntax.Redirect)
		if !ok || redirect.N == nil {
			return true
		}
		fd, err := strconv.Atoi(redirect.N.Value)
		if err == nil && fd > 2 {
			unsupportedFD = redirect.N.Value
			return false
		}
		return true
	})
	if unsupportedFD != "" {
		message := "file descriptor " + unsupportedFD + " redirection is unsupported"
		_, _ = fmt.Fprintln(errorOutput, message)
		return map[string]any{"stdout": array(out.Bytes()), "stderr": array(errout.Bytes()), "code": 2, "error": message, "cwd": runner.Dir}, nil
	}
	e = runner.Run(ctx, tree)
	code := 0
	errorText := ""
	if e != nil {
		errorText = e.Error()
		if errors.Is(e, context.Canceled) {
			code = 130
		} else if n, ok := interp.IsExitStatus(e); ok {
			code = int(n)
		} else {
			// Transport failures, including rejected process allocations, are
			// shell errors rather than ordinary child exit statuses.
			_, _ = fmt.Fprintln(errorOutput, e)
			code = 1
		}
	}
	if persistent {
		return map[string]any{"stdout": array(out.Bytes()), "stderr": array(errout.Bytes()), "code": code, "error": errorText, "cwd": runner.Dir}, nil
	}
	functions := make(map[string]string, len(runner.Funcs))
	for name, body := range runner.Funcs {
		var source bytes.Buffer
		if e := syntax.NewPrinter().Print(&source, body); e != nil {
			return nil, e
		}
		functions[name] = source.String()
	}
	state, e := json.Marshal(shellSnapshot{Version: 1, Variables: runner.Vars, Functions: functions})
	if e != nil {
		return nil, e
	}
	if len(state) > 65536 {
		return nil, fmt.Errorf("shell state exceeds limit")
	}
	return map[string]any{"stdout": array(out.Bytes()), "stderr": array(errout.Bytes()), "code": code, "error": errorText, "cwd": runner.Dir, "shellState": string(state)}, nil
}
func main() {
	js.Global().Set("goShellInterrupt", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		sessionMu.Lock()
		cancel := sessionCancel
		sessionMu.Unlock()
		if cancel == nil {
			return false
		}
		cancel()
		return true
	}))
	js.Global().Set("goShell", js.FuncOf(func(_ js.Value, a []js.Value) any {
		script := a[0].String()
		timeout := a[1].Int()
		cwd := a[2].String()
		environment := map[string]string{}
		if e := json.Unmarshal([]byte(a[3].String()), &environment); e != nil {
			return promise(func() (any, error) { return nil, e })
		}
		streaming := len(a) > 5 && a[5].Bool()
		priorState := ""
		if len(a) > 6 && !a[6].IsUndefined() {
			priorState = a[6].String()
		}
		persistent := len(a) > 7 && a[7].Bool()
		var stdin []byte
		if !streaming {
			stdin = raw(a[4])
		}
		return promise(func() (any, error) {
			return run(script, timeout, cwd, environment, stdin, streaming, priorState, persistent)
		})
	}))
	select {}
}
