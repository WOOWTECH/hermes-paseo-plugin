Runtime locking, process supervision and conversation verification adapted from WOOWTECH/pi-paseo-plugin v0.1.3 under MIT. Hermes integration uses official plugin and ACP interfaces.

Connection targets (Paseo, Woowtech Smart, Apporo Smart) and the brand identity patch of the managed daemon (src/connection-targets.mjs, src/brand-identity.mjs, src/brand-identity-patch.mjs) follow WOOWTECH/pi-paseo-plugin (Agent Connect), MIT, with this plugin's own helper file name and environment variable (HERMES_PASEO_CONNECTION_TARGET).

Vendored test fixture. tests/fixtures/paseo-0.11.2/websocket-server.js.gz is one unmodified file of the Paseo project (https://github.com/getpaseo/paseo): dist/server/server/websocket-server.js of the npm package @getpaseo/server 0.11.2, gzip-compressed; tests/fixtures/paseo-0.11.2/provenance.json records its SHA-256 and the tarball integrity that runtime/package-lock.json pins. It is used only by offline tests. The plugin never loads it and ships no other copy: the managed runtime is installed by npm from the lock file.

- Licence of that file. The 0.11.2 package carries no LICENSE file and no license field; its README ends with "## License" and "MIT". Later @getpaseo/server releases (0.16.x and 0.17.x) declare the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0) and ship its text; nothing from those releases is vendored here.
- Copyright notice and MIT permission notice for the vendored file. The 0.11.2 package prints no copyright line of its own; the LICENSE file that later releases of the same package ship (checked in 0.17.4) begins "Copyright (c) 2025-present Mohamed Boudra", and that line is used here. The MIT terms the 0.11.2 README names follow, to be included in all copies or substantial portions of the file as the licence requires:

      Copyright (c) 2025-present Mohamed Boudra

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
- Modification notice. The patch in src/brand-identity-patch.mjs adds one import line and one property (`brand: agentConnectBrand,` after `status: "server_info",`) to the copy of that file inside the user's own runtime directory, only when its SHA-256 is exactly that of the published file. The patched file is not redistributed, and no other Paseo file is changed.
