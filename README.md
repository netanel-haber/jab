<img src="https://jab.run/icon.png" alt="jab" height="64">

**Smart Tab.** Pressing <kbd>Ctrl</kbd>+<kbd>Q</kbd> will highlight the control/field that the ranker assumes you want, based on the current page, focused elements, etc. <kbd>Enter</kbd> uses it.

**[Add to Chrome](https://chromewebstore.google.com/detail/jab/dfnikmnfgjnbmhfnpeigignlgpkggbji)**

> **Mom can we have `tab`?**

> We have `tab` at home.

<img src="https://jab.run/demo.gif" width="840" alt="jab on a news page: Ctrl+Q highlights the top story, and Enter opens it.">

The ranker is lean: Just 18KB, LightGBM (2016) trees running in-browser CPU-only in about 2ms. No network requests, nothing leaves the browser ([privacy](https://jab.run/PRIVACY.html)).

- The first <kbd>Ctrl</kbd>+<kbd>Q</kbd> will highlight the control (its badge reads 1 Enter ↘), as well as up to 3 other picks with small numbered badges, each with an arrow to its control: fewer when jab isn't sure of them, and the page's search box among them when they are all list items or deep links, as a way on to anything else. Nothing is focused yet, so nothing pops open.
- <kbd>Enter</kbd>: uses the highlighted control. A button is pressed, a link followed, a field focused (a date picker opens). Or just type: a highlighted text field gets the focus and what you type.
- Tap <kbd>Ctrl</kbd>+<kbd>Q</kbd> again: the focus moves to the next pick.
- Hold <kbd>Ctrl</kbd>+<kbd>Q</kbd> and press <kbd>1</kbd> to <kbd>4</kbd>: Straight to that one.

Anything else you do (<kbd>Esc</kbd>, clicking, another key) ends it, and the next <kbd>Ctrl</kbd>+<kbd>Q</kbd> will be a new session.

Open source (MIT): [github.com/netanel-haber/jab](https://github.com/netanel-haber/jab)

<details><summary>MIT License</summary>

Copyright (c) 2026 Netanel Haber

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

</details>
