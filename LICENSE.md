# License

## MIT License

## **Copyright © 2026 PrintBit Contributors**

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## About This Project

**PrintBit** is a coin-operated, self-service printing kiosk system developed
as a capstone project. It runs on Windows and integrates Node.js/Express.js,
Socket.IO, Arduino/ESP32 hardware (coin acceptor & hopper),
and WMI-based printer monitoring into a unified kiosk experience
designed for deployment in campus environments.

### Contributors

| Name            | GitHub                                   |
| --------------- | ---------------------------------------- |
| Gio Majadas     | [@GioMjds](https://github.com/GioMjds)   |
| Harold Aldovino | [@Onib-H](https://github.com/Onib-H)     |
| Ryan Anin       | [@raii23](https://github.com/raii23)     |
| Ben Dela Torre  | [@bendlttr](https://github.com/bendlttr) |

### Third-Party Licenses

PrintBit depends on several open-source libraries. Their respective licenses
apply to their source code and are unaffected by this license. Key dependencies
include:

| Package        | License    |
| -------------- | ---------- |
| Express.js     | MIT        |
| Socket.IO      | MIT        |
| SQLite         | MIT        |
| serialport     | MIT        |
| pdfjs-dist     | Apache 2.0 |
| pdf-to-printer | MIT        |
| sharp          | Apache 2.0 |
| argon2         | MIT        |

For a full list of dependencies and their licenses, refer to the
`package.json` files within the monorepo packages.

---

> This project was created for academic purposes. The authors make no
> guarantees of fitness for production use. Hardware integration components
> (coin acceptors, printers, ESP32 modules) require proper configuration
> and physical setup as described in the project documentation.
