# Narrow engine proof: WebKitGTK uses the same webview backend as Linux Tauri.
import gi
import json

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

settings = Gtk.Settings.get_default()
settings.set_property('gtk-application-prefer-dark-theme', False)
view = WebKit2.WebView()
window = Gtk.Window()
window.add(view)
window.show_all()
results = []

def sample(label):
    def received(webview, result, _):
        value = webview.evaluate_javascript_finish(result).to_string()
        results.append({'step': label, 'webview': json.loads(value)})
        if label == 'light':
            settings.set_property('gtk-application-prefer-dark-theme', True)
            GLib.timeout_add(700, lambda: sample('dark'))
        elif label == 'dark':
            settings.set_property('gtk-application-prefer-dark-theme', False)
            GLib.timeout_add(700, lambda: sample('light-again'))
        else:
            print(json.dumps(results, indent=2), flush=True)
            Gtk.main_quit()
    view.evaluate_javascript('JSON.stringify({dark:matchMedia("(prefers-color-scheme: dark)").matches, changes:window.changes})', -1, None, None, None, received, None)
    return False

def loaded(webview, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(300, lambda: sample('light'))

view.connect('load-changed', loaded)
view.load_html('<script>window.changes=[];matchMedia("(prefers-color-scheme: dark)").addEventListener("change",e=>window.changes.push(e.matches));</script>', 'http://localhost/')
GLib.timeout_add_seconds(10, lambda: Gtk.main_quit())
Gtk.main()
assert [r['webview']['dark'] for r in results] == [False, True, False], results
assert results[-1]['webview']['changes'] == [True, False], results
