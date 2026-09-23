import {runSIMDBasics} from './wasm-simd-cases.mjs'
import {runSIMDValueMovement,expectedSIMDValueMovement} from './wasm-simd-value-cases.mjs'
import {runSIMDBytes,expectedSIMDBytes} from './wasm-simd-byte-cases.mjs'
import {runSIMDComparisons,expectedSIMDComparisons} from './wasm-simd-comparison-cases.mjs'
import {runSIMDReductions,expectedSIMDReductions} from './wasm-simd-reduction-cases.mjs'
import {runSIMDIntegers,expectedSIMDIntegers} from './wasm-simd-integer-cases.mjs'
import {runSIMDLanes,expectedSIMDLanes} from './wasm-simd-lane-cases.mjs'
import {runSIMDMemory,expectedSIMDMemory} from './wasm-simd-memory-cases.mjs'
import {runSIMDWiden,expectedSIMDWiden} from './wasm-simd-widen-cases.mjs'

// Shared by assembly, native references and guest execution. Runners are
// self-contained because the harness serializes them into QuickJS.
export const simdFixtures=[
  {name:'basic',manifest:'manifest',run:runSIMDBasics,expected:{addLane:33,multiplyLane:45,localCall:42,floatLane:3.75,source:[7,17,27,37],stored:[9,19,29,39]}},
  {name:'value-movement',manifest:'value-movement-manifest',run:runSIMDValueMovement,expected:expectedSIMDValueMovement},
  {name:'byte-bitwise',manifest:'byte-bitwise-manifest',run:runSIMDBytes,expected:expectedSIMDBytes},
  {name:'comparisons',manifest:'comparisons-manifest',run:runSIMDComparisons,expected:expectedSIMDComparisons},
  {name:'reductions-shifts',manifest:'reductions-shifts-manifest',run:runSIMDReductions,expected:expectedSIMDReductions},
  {name:'integer-arithmetic',manifest:'integer-arithmetic-manifest',run:runSIMDIntegers,expected:expectedSIMDIntegers},
  {name:'lanes',manifest:'lanes-manifest',run:runSIMDLanes,expected:expectedSIMDLanes},
  {name:'memory-variants',manifest:'memory-variants-manifest',run:runSIMDMemory,expected:expectedSIMDMemory},
  {name:'widen-narrow',manifest:'widen-narrow-manifest',run:runSIMDWiden,expected:expectedSIMDWiden},
]
