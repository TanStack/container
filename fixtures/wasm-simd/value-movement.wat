(module
  (type $mixed (func (param i32 v128 i64) (result i32 v128 i64)))
  (table 1 funcref)
  (global $saved (mut v128) (v128.const i32x4 10 20 30 40))
  (func $shift (type $mixed)
    local.get 0 i32.const 1 i32.add
    local.get 1 i32.const 2 i32x4.splat i32x4.add
    local.get 2 i64.const 3 i64.add)
  (elem (i32.const 0) $shift)
  (func $nested (type $mixed)
    local.get 0 local.get 1 local.get 2 call $shift call $shift)
  (func (export "direct") (result i32) (local i32 v128 i64)
    i32.const 5 v128.const i32x4 1 2 3 4 i64.const 9 call $nested
    local.set 2 local.set 1 local.set 0
    local.get 0 local.get 1 i32x4.extract_lane 3 i32.add
    local.get 2 i32.wrap_i64 i32.add)
  (func (export "indirect") (result i32) (local i32 v128 i64)
    i32.const 5 v128.const i32x4 1 2 3 4 i64.const 9 i32.const 0 call_indirect (type $mixed)
    local.set 2 local.set 1 local.set 0
    local.get 0 local.get 1 i32x4.extract_lane 3 i32.add
    local.get 2 i32.wrap_i64 i32.add)
  (func (export "globals") (result i32)
    global.get $saved i32.const 1 i32x4.splat i32x4.add global.set $saved
    global.get $saved i32x4.extract_lane 2)
  (func $choose (export "choose") (param i32) (result i32)
    v128.const i32x4 11 12 13 14
    v128.const i32x4 21 22 23 24
    local.get 0 select i32x4.extract_lane 1)
  (func (export "branch") (param i32) (result i32)
    block $done (result v128)
      v128.const i32x4 31 32 33 34
      local.get 0 br_if $done
      drop
      v128.const i32x4 41 42 43 44
    end
    i32x4.extract_lane 2)
  (func (export "locals") (result i32) (local v128 v128 v128)
    v128.const i32x4 1 2 3 4 local.set 0
    v128.const i32x4 10 20 30 40 local.set 1
    v128.const i32x4 100 200 300 400 local.set 2
    local.get 0 local.get 1 i32x4.add local.tee 0 drop
    i32.const 0 call $choose drop
    local.get 0 local.get 2 i32x4.add i32x4.extract_lane 3))
