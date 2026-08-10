/** Reads stdin with a hard deadline. Returns whatever arrived if time runs out. */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    let done = false
    const finish = () => { if (!done) { done = true; resolve(data) } }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => { data += c })
    process.stdin.on('end', () => { clearTimeout(timer); finish() })
    process.stdin.on('error', () => { clearTimeout(timer); finish() })
  })
}
