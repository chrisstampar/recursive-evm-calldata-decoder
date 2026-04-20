# Security

This project is a **client-side** web application: calldata is decoded in the browser. There is **no server component** in this repository that stores user input.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for undisclosed security problems.

1. Open a **[GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** (private report) for this repository, **or**
2. Contact the maintainers through the contact method listed on the repository profile / README once published.

Include steps to reproduce, affected versions or commit, and impact if known.

## Out of scope

- **RPC or third-party API availability** — the app calls public endpoints (chain RPCs, signature directories) subject to their own terms and outages.
- **Social engineering** or issues in **user-supplied ABI JSON** pasted into the app (treat pasted ABIs as untrusted input).
- Findings that require **physical access** to the reporter’s machine or **malicious browser extensions** that already bypass same-origin policy.

## Design notes

- A **Content Security Policy** is set in `index.html`; prefer fixing bypasses in policy or rendering paths rather than weakening CSP without cause.
- **Output sanitization** applies to decoded strings shown in the UI; XSS reports should reference concrete DOM injection paths.
