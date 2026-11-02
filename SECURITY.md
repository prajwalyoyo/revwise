# Security Policy

Revwise is built from the ground up for strict privacy, offline reliability, and data isolation.

## Security Architecture & Privacy Invariants

- **Offline by Design**: Revwise executes the local `git` CLI directly on your machine.
- **Zero Remote Telemetry**: Revwise never transmits telemetry, code snippets, commit messages, or repository metadata over the network.
- **No Bundled Dependencies**: Revwise contains zero third-party runtime npm packages, eliminating the risk of software supply-chain attacks.
- **Sandboxed Webviews**: Webviews run under strict Content Security Policies (`default-src 'none'`) preventing remote script injection.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Revwise, please report it responsibly:

1. **Do not disclose the issue publicly** in GitHub issues or discussions.
2. Submit a report privately via **GitHub Security Advisories** on the repository, or email the maintainers directly.
3. Please include:
   - A detailed description of the vulnerability
   - Steps to reproduce or proof-of-concept
   - The version of Revwise and VS Code tested
   - Potential impact

We will acknowledge receipt within 48 hours and work with you to release a fix promptly.
