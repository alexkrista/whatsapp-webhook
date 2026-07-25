# Admin an KRISTA UI anbinden

Die aktuelle `public/admin.html` war im Build 0023.17 nicht enthalten. Nicht mit einer älteren Version überschreiben.

In die aktuelle Admin-Datei im `<head>` einfügen:

```html
<link rel="stylesheet" href="/public/ui/krista-ui.css">
```

Direkt nach `<body>`:

```html
<div id="kristaTopbar"></div>
```

Vor dem bestehenden Admin-JavaScript:

```html
<script src="/public/ui/topbar.js"></script>
<script>createKristaTopbar({active:"admin",build:"0023.18"});</script>
```
