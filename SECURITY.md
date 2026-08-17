# Security policy

## Supported versions

Security fixes are prepared for the latest published `dsh-open-file` version. The current `0.1.0` package targets DeepSeek Harness `0.1.0-rc.6` and Node.js `22.13.0` or newer.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Contact the repository owner privately and include the affected version, a minimal reproduction, impact, and any suggested mitigation. Do not include uploaded user documents or secrets.

## Security boundaries

- All source and derived artifacts stay under the active session workspace at `.dsh/open-file/`.
- The upload API accepts same-origin requests and raw binary streams only.
- Managed paths reject symbolic links and path traversal.
- ZIP processing rejects unsafe paths, links, encryption, duplicates, invalid CRC, excessive expansion and excessive compression ratios.
- Office XML parsing rejects DTD and entity declarations.
- Local OCR uses packaged English and Simplified Chinese data and does not download language data at runtime.

Uploaded files and extracted text are untrusted input. Operators should use conservative size/time limits and avoid exposing the Web server beyond their intended trust boundary.
