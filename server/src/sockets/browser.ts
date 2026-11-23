/** Short browser label for logs, e.g. "Chrome 142 / Windows". */
export function browserLabel(ua: string) {
  const b = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /SamsungBrowser\/(\d+)/.exec(ua) ? `Samsung Internet ${/SamsungBrowser\/(\d+)/.exec(ua)![1]}`
    : /CriOS\/(\d+)/.exec(ua) ? `Chrome iOS ${/CriOS\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
    : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
    : "browser?";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Tizen|Web0S|SmartTV/i.test(ua) ? "TV" : /Linux/.test(ua) ? "Linux" : "?";
  return `${b} / ${os}${/HeadlessChrome/.test(ua) ? " (headless)" : ""}`;
}
