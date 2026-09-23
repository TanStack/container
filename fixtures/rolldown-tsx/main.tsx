type Props = { answer: number }
function h(tag: string, props: Props | null, ...children: unknown[]) {
  return { tag, props, children }
}
export const view = <output answer={42}>ready</output>
export async function loadAnswer(): Promise<number> {
  const { answer } = await import('./lazy.ts')
  return answer
}
