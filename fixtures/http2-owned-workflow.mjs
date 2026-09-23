import { singlePeerFactory } from '../scripts/http2-owned-peer.mjs'
import * as protocol from './http2-workflow.mjs'
export const http2Workflow = (factory, binary, fragment) => protocol.http2Workflow(singlePeerFactory(factory), binary, fragment)
export const http2Limits = (factory, binary) => protocol.http2Limits(singlePeerFactory(factory), binary)
export const http2Streaming = (factory, binary, fragment) => protocol.http2Streaming(singlePeerFactory(factory), binary, fragment)
