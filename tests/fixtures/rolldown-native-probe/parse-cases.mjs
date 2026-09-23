export const parseCases=[
  {name:'javascript',filename:'sample.js',source:'// exported value\nexport const answer = 42',options:{lang:'js'}},
  {name:'typescript',filename:'sample.ts',source:'export const answer: number = 42',options:{lang:'ts'}},
  {name:'jsx',filename:'sample.jsx',source:'export const view = <section title="test">hello</section>',options:{lang:'jsx'}},
  {name:'bigint',filename:'sample.js',source:'export const value = 12345678901234567890n',options:{lang:'js'}},
  {name:'regex',filename:'sample.js',source:'export const pattern = /hello+/gi',options:{lang:'js'}},
  {name:'invalid syntax',filename:'broken.js',source:'export const = ;',options:{lang:'js'}},
]
