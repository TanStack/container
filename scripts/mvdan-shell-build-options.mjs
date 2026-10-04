export const mvdanShellGoBuild = {
  trimpath: true,
  buildvcs: false,
  ldflags: ['-s', '-w'],
}

export function mvdanShellBuildArguments(output) {
  return ['build', '-trimpath', '-buildvcs=false', '-mod=readonly',
    '-ldflags=' + mvdanShellGoBuild.ldflags.join(' '), '-o', output, '.']
}
