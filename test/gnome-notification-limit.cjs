const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Signals {
    handlers = new Map();
    next = 1;
    connect(name, callback) {
        const id = this.next++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) {
        assert.ok(this.handlers.delete(id), 'unknown signal disconnected');
    }
    emit(name, ...args) {
        for (const handler of [...this.handlers.values()])
            if (handler.name === name) handler.callback(this, ...args);
    }
}

class Actor extends Signals {
    children = [];
    styles = new Set();
    visible = true;
    get_children() { return [...this.children]; }
    get_first_child() { return this.children[0]; }
    get_parent() { return this.parent; }
    insert_child_at_index(child, index) {
        assert.ok(!child.parent);
        this.children.splice(index, 0, child);
        child.parent = this;
        this.emit('child-added', child);
    }
    remove_child(child) {
        assert.equal(child.parent, this);
        this.children.splice(this.children.indexOf(child), 1);
        child.parent = null;
    }
    add_style_class_name(name) { this.styles.add(name); }
    remove_style_class_name(name) { this.styles.delete(name); }
    has_style_class_name(name) { return this.styles.has(name); }
    hide() { this.visible = false; }
}
const list = new Actor();
function message(app, expanded = false) {
    const m = new Actor();
    m.notification = {source: {title: app}};
    m.expanded = expanded;
    m.expand = () => { m.expanded = true; };
    m.unexpand = () => { m.expanded = false; };
    m.titleLabel = new Actor();
    m.titleParent = new Actor();
    m.titleParent.insert_child_at_index(m.titleLabel, 0);
    m.sourceTitle = new Actor();
    m.headerContent = new Actor();
    m.headerContent.add_style_class_name('message-header-content');
    m.headerContent.insert_child_at_index(m.sourceTitle, 0);
    m._header = new Actor();
    m._header.insert_child_at_index(m.headerContent, 0);
    const item = new Actor();
    item.child = m;
    list.insert_child_at_index(item, 0);
    return m;
}
const existingPi = message('Pi');
const existingOther = message('Mail', true);
const tray = new Signals();
const sources = [];
tray.getSources = () => [...sources];
const pending = new Map();
let nextIdle = 1;
const GLib = {
    PRIORITY_DEFAULT_IDLE: 200,
    SOURCE_REMOVE: false,
    idle_add(priority, callback) {
        assert.equal(priority, 200);
        const id = nextIdle++;
        pending.set(id, callback);
        return id;
    },
    source_remove(id) { assert.ok(pending.delete(id)); },
};
const sourceText = fs.readFileSync(path.join(__dirname, '../gnome-notification-limit/extension.js'), 'utf8');
const ExtensionClass = vm.runInNewContext(sourceText.replace(/^import .*;\n/gm, '').replace('export default class', 'class') + '\nNotificationLimit;', {
    GLib, Extension: class {}, Main: {messageTray: tray, panel: {statusArea: {dateMenu: {_messageList: {_notificationSection: {_list: list}}}}}}, NotificationDestroyedReason: {EXPIRED: 1},
});
const expired = [];
function addSource() {
    const source = new Signals();
    source.notifications = [];
    sources.push(source);
    tray.emit('source-added', source);
    return source;
}
function add(source, time) {
    const n = {
        datetime: {time, compare(other) { return this.time - other.time; }},
        destroy(reason) {
            assert.equal(reason, 1);
            const index = source.notifications.indexOf(this);
            assert.notEqual(index, -1, 'notification destroyed twice');
            source.notifications.splice(index, 1);
            expired.push(this);
            if (!source.notifications.length) {
                sources.splice(sources.indexOf(source), 1);
                tray.emit('source-removed', source);
            }
        },
    };
    source.notifications.push(n);
    source.emit('notification-added', n);
    return n;
}
function flush() {
    for (const [id, callback] of [...pending]) {
        pending.delete(id);
        assert.equal(callback(), false);
    }
}
function times() {
    return sources.flatMap(s => s.notifications.map(n => n.datetime.time)).sort((a, b) => a - b);
}

for (let i = 0; i < 5; i++) {
    const source = addSource();
    for (let j = 0; j < 3; j++) add(source, i * 3 + j);
}
const extension = new ExtensionClass();
extension.enable();
assert.ok(existingPi.expanded);
assert.equal(existingPi.titleLabel.get_parent(), existingPi.headerContent);
assert.equal(existingPi.sourceTitle.visible, false);
assert.equal(existingOther.titleLabel.get_parent(), existingOther.titleParent);
assert.equal(existingOther.sourceTitle.visible, true);
assert.ok(list.has_style_class_name('compact-notifications'));
const newPi = message('Pi');
assert.ok(newPi.expanded);
list.emit('child-added', list.get_first_child());
assert.equal(newPi.titleLabel.get_parent(), newPi.headerContent, 'reorder duplicated compaction');
newPi.emit('destroy');
list.remove_child(list.get_first_child());
assert.equal(extension._messages.has(newPi), false);
assert.equal(times().length, 15, 'trim must wait until notification signals finish');
flush();
assert.deepEqual(times(), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
assert.equal(expired.length, 5);

const updated = sources.flatMap(s => s.notifications).find(n => n.datetime.time === 5);
updated.datetime.time = 100;
const added = addSource();
for (let i = 20; i < 23; i++) add(added, i);
assert.equal(pending.size, 1, 'burst scheduled multiple trims');
flush();
assert.deepEqual(times(), [9, 10, 11, 12, 13, 14, 20, 21, 22, 100]);

add(added, 101);
extension.disable();
assert.equal(pending.size, 0);
assert.equal(tray.handlers.size, 0);
assert.equal(list.handlers.size, 0);
assert.ok(!list.has_style_class_name('compact-notifications'));
assert.equal(existingPi.titleLabel.get_parent(), existingPi.titleParent);
assert.equal(existingPi.sourceTitle.visible, true);
assert.equal(existingPi.expanded, false);
assert.equal(existingOther.expanded, true);
assert.equal(existingPi.handlers.size, 0);
for (const source of sources) assert.equal(source.handlers.size, 0);
assert.equal(times().length, 11, 'disable unexpectedly removed notifications');
extension.enable();
flush();
assert.equal(times().length, 10);
assert.equal(times()[0], 10);
extension.disable();
console.log('PASS notification cap: existing history, cross-app oldest-first eviction, updates, deferred bursts, source removal and disable/re-enable');
console.log('PASS compact history: existing/new cards, Pi header deduplication, other-app titles, reorder, destruction and exact disable restoration');
