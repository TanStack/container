(module
  (type $step (func (param i32) (result i32)))
  (type $wide (func (param i32 i32 i32 i64 f64) (result i32)))
  (table 3 funcref)
  (elem (i32.const 0) $indirect)
  (elem (i32.const 1) $add $subtract)
  (func (export "mixedLoop") (param $n i32) (result i32)
    local.get $n i32.const 11 i32.const 13 i64.const 17 f64.const 1
    call $loop)
  (func $loop (type $wide) (param $n i32) (param $a i32) (param $b i32) (param $r i64) (param $f f64) (result i32)
    (local $subtract i32)
    (block $done
      (loop $again
        local.get $n i32.eqz br_if $done
        local.get $subtract
        if
          local.get $r i64.const 1 i64.sub local.set $r
          local.get $f f64.const 1 f64.sub local.set $f
        else
          local.get $r i64.const 1 i64.add local.set $r
          local.get $f f64.const 1 f64.add local.set $f
        end
        local.get $subtract i32.const 1 i32.xor local.set $subtract
        local.get $n i32.const 1 i32.sub local.set $n
        br $again))
    local.get $a local.get $b i32.add local.get $r i32.wrap_i64 i32.add
    local.get $f i32.trunc_f64_s i32.add)
  (func (export "mixed") (param $n i32) (result i32)
    local.get $n i32.const 11 i32.const 13 i64.const 17 f64.const 1
    call $add)
  (func $add (type $wide) (param $n i32) (param $a i32) (param $b i32) (param $r i64) (param $f f64) (result i32)
    local.get $n i32.eqz
    if
      local.get $a local.get $b i32.add local.get $r i32.wrap_i64 i32.add
      local.get $f i32.trunc_f64_s i32.add return
    end
    local.get $n i32.const 1 i32.sub
    local.get $a local.get $b
    local.get $r i64.const 1 i64.add
    local.get $f f64.const 1 f64.add
    i32.const 2 return_call_indirect (type $wide))
  (func $subtract (type $wide) (param $n i32) (param $a i32) (param $b i32) (param $r i64) (param $f f64) (result i32)
    local.get $n i32.eqz
    if
      local.get $a local.get $b i32.add local.get $r i32.wrap_i64 i32.add
      local.get $f i32.trunc_f64_s i32.add return
    end
    local.get $n i32.const 1 i32.sub
    local.get $a local.get $b
    local.get $r i64.const 1 i64.sub
    local.get $f f64.const 1 f64.sub
    i32.const 1 return_call_indirect (type $wide))
  (func $direct (export "direct") (type $step) (param $n i32) (result i32)
    local.get $n i32.eqz
    if i32.const 42 return end
    local.get $n i32.const 1 i32.sub
    return_call $direct)
  (func $indirect (export "indirect") (type $step) (param $n i32) (result i32)
    local.get $n i32.eqz
    if i32.const 42 return end
    local.get $n i32.const 1 i32.sub
    i32.const 0
    return_call_indirect (type $step)))
