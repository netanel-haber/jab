# jab privacy policy

Last updated: October 22, 2026

jab is a smart tab: a browser extension that highlights the control you most likely want next when you press Ctrl+., and uses it when you press Enter.

## What jab reads

When you press Ctrl+., jab reads the page you are on, in your browser:

- the focusable controls (links, buttons, fields): their kind, label, link address, position, size, look, and the text around them;
- whether a field is filled in (not what is typed in it);
- the page's address, title, description and main heading.

## What jab does with it

It ranks the controls on your own device, with a model that ships inside the extension, and highlights the best ones. That is all.

- Nothing is sent anywhere. jab makes no network requests and loads no files: its model is part of its own script.
- Nothing is stored. What jab reads is discarded as soon as the ranking is done; it keeps no history and no logs. The one setting,
  a shortcut other than Ctrl+. if you set one, is kept in your browser's extension storage, which your browser syncs to your
  other devices if you sync.
- Nothing is shared or sold, and there are no analytics, ads or third-party code.

## Permissions

jab runs on every page (`<all_urls>`) so that its shortcut works wherever you are, and uses `storage` to keep the shortcut you
set. It asks for no other permissions.

## Contact

Questions: open an issue at <https://github.com/netanel-haber/jab/issues>.
