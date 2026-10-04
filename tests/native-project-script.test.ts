import {expect,test} from 'vitest'
import {parseNativeDevCommand,parseNativeInstallCommand,parseNativeStartCommand,planNativeBuildScript,readNativeDevScript} from '../src/native/project-script'

test('resolves declared package-manager commands without executing a host shell',()=>{
  expect(parseNativeInstallCommand('pnpm install')).toBe('pnpm install')
  expect(parseNativeInstallCommand('npm ci --ignore-scripts')).toBe('npm ci --ignore-scripts')
  expect(parseNativeStartCommand('pnpm run dev')).toBe('dev')
  expect(parseNativeStartCommand('npm run start:preview')).toBe('start:preview')
  expect(()=>parseNativeInstallCommand('pnpm install && curl example.com')).toThrow('Unsupported native install command')
  expect(()=>parseNativeStartCommand('pnpm run dev -- --host')).toThrow('Unsupported native start command')
})

test('resolves ordinary Vite and Node dev scripts',()=>{
  expect(parseNativeDevCommand('vite dev')).toEqual({kind:'vite-dev'})
  expect(parseNativeDevCommand('node server')).toEqual({kind:'node',entry:'server'})
  expect(readNativeDevScript('{"scripts":{"dev":"vite dev"}}','dev')).toEqual({kind:'vite-dev'})
})

test('rejects shell commands and undeclared scripts',()=>{
  expect(()=>parseNativeDevCommand('node server && echo done')).toThrow('Unsupported native dev command')
  expect(()=>parseNativeDevCommand('vite build')).toThrow('Unsupported native dev command')
  expect(()=>readNativeDevScript('{"scripts":{}}','dev')).toThrow('No package script named dev')
})

test('plans sequential Vite and TypeScript build steps before execution',()=>{
  expect(planNativeBuildScript('{"scripts":{"build":"vite build && tsc --noEmit"}}','build')).toEqual([
    {kind:'vite-build',ssr:false},{kind:'typescript-no-emit'},
  ])
  expect(planNativeBuildScript('{"scripts":{"build":"npm run build:client && pnpm run build:server","build:client":"vite build","build:server":"vite build --ssr"}}','build')).toEqual([
    {kind:'vite-build',ssr:false},{kind:'vite-build',ssr:true},
  ])
})

test('rejects unsupported or cyclic build scripts before running a step',()=>{
  expect(()=>planNativeBuildScript('{"scripts":{"build":"vite build && curl example.com"}}','build')).toThrow('Unsupported native build command')
  expect(()=>planNativeBuildScript('{"scripts":{"build":"npm run build"}}','build')).toThrow('Project script cycle')
})
