export const el = (tag: string, props: any = {}, children: any[] = []): any => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) {
    if (child != null && child !== false) node.append(child)
  }
  return node
}
