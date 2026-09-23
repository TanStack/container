(module
  (func (export "choose") (param i32) (result i32)
    local.get 0
    if (result i32)
      block (result i32)
        i32.const 13
        br 0
        unreachable
      end
    else
      i32.const 29
    end)
  (func (export "passthrough") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    if (param i32) (result i32)
      i32.const 7
      i32.add
    end)
  (func (export "sum") (param i32) (result i32) (local i32)
    block
      loop
        local.get 0
        i32.eqz
        br_if 1
        local.get 1
        local.get 0
        i32.add
        local.set 1
        local.get 0
        i32.const 1
        i32.sub
        local.set 0
        br 0
      end
    end
    local.get 1)
  (func (export "pair") (param i32) (result i32 i64)
    local.get 0
    if (result i32 i64)
      i32.const 3
      i64.const 5
    else
      i32.const 7
      i64.const 11
    end)
  (func (export "branch") (param i32) (result i32)
    block (result i32)
      block (result i32)
        i32.const 31
        local.get 0
        br_table 0 1
      end
      i32.const 1
      i32.add
    end)
  (func (export "loopParameter") (param i32) (result i32)
    local.get 0
    loop (param i32) (result i32)
      i32.const 1
      i32.sub
      local.tee 0
      local.get 0
      br_if 0
    end)
  (func (export "nestedElse") (param i32 i32) (result i32)
    local.get 0
    if (result i32)
      local.get 1
      if (result i32)
        i32.const 1
      else
        i32.const 2
      end
    else
      local.get 1
      if (result i32)
        i32.const 3
      else
        i32.const 4
      end
    end)
)
