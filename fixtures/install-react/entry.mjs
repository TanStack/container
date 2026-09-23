import React from 'react'
import {renderToReadableStream} from 'react-dom/server.browser'

const stream=await renderToReadableStream(React.createElement('h1',null,'Installed in the worker'))
console.log(await new Response(stream).text())
