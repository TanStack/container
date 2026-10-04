export function unexpectedPreviewErrors(errors, documentTraces, failedPreviewRequests) {
  return errors.filter(error => {
    const phase = error.slice(0, error.indexOf(':'))
    if (!/^counter (?:reload \d+|page reload|Run restart)$/.test(phase) &&
      !phase.startsWith('terminal command ')) return true
    const outgoingError = documentTraces.find(entry => {
      const match = /^(.+?): \[native-document\] error (\S+) (.+)$/.exec(entry)
      return match?.[1] === phase && error.includes(match[3]) &&
        documentTraces.some(later => {
          const hidden=/^(.+?): \[native-document\] pagehide (\S+)$/.exec(later)
          return hidden?.[2]===match[2] && (hidden[1]===phase ||
            (phase.startsWith('terminal command ') && hidden[1].startsWith('terminal command ')))
        })
    })
    if (!outgoingError) return true
    const failedURL = /error loading dynamically imported module: (https?:\/\/\S+)/.exec(error)?.[1]
    return !failedPreviewRequests.some(request => request.startsWith(`${phase}: `) &&
      /"errorText":"(?:NS_BINDING_ABORTED|cancelled)"/.test(request) &&
      (!failedURL || request.endsWith(` ${failedURL}`)))
  })
}
