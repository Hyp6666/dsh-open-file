export function npmInvocation(
  { npmExecPath, nodeExecPath, platform = process.platform },
  args
) {
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    return Object.freeze({
      command: nodeExecPath,
      args: Object.freeze([npmExecPath, ...args])
    });
  }
  if (platform === "win32") {
    return Object.freeze({
      command: process.env.ComSpec ?? "cmd.exe",
      args: Object.freeze(["/d", "/s", "/c", "npm", ...args])
    });
  }
  return Object.freeze({ command: "npm", args: Object.freeze([...args]) });
}
