import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotificationDestroyedReason} from 'resource:///org/gnome/shell/ui/messageTray.js';

export default class NotificationLimit extends Extension {
    enable() {
        this._sources = new Map();
        this._idle = 0;
        this._added = Main.messageTray.connect('source-added', (_tray, source) => {
            this._watch(source);
            this._scheduleTrim();
        });
        this._removed = Main.messageTray.connect('source-removed', (_tray, source) => {
            source.disconnect(this._sources.get(source));
            this._sources.delete(source);
        });
        for (const source of Main.messageTray.getSources())
            this._watch(source);
        this._scheduleTrim();
        this._messages = new Map();
        this._list = Main.panel.statusArea.dateMenu._messageList._notificationSection._list;
        this._list.add_style_class_name('compact-notifications');
        this._messageAdded = this._list.connect('child-added', (_list, item) => this._compactMessage(item.child));
        for (const item of this._list.get_children())
            this._compactMessage(item.child);
    }

    _compactMessage(message) {
        if (this._messages.has(message))
            return;
        const saved = {expanded: message.expanded};
        if (message.notification.source.title === 'Pi') {
            saved.titleParent = message.titleLabel.get_parent();
            const headerContent = message._header.get_children().find(child => child.has_style_class_name('message-header-content'));
            saved.sourceTitle = headerContent.get_first_child();
            saved.sourceVisible = saved.sourceTitle.visible;
            saved.sourceTitle.hide();
            saved.titleParent.remove_child(message.titleLabel);
            headerContent.insert_child_at_index(message.titleLabel, 0);
        }
        saved.destroy = message.connect('destroy', () => this._messages.delete(message));
        this._messages.set(message, saved);
        message.expand(false);
    }

    _watch(source) {
        this._sources.set(source, source.connect('notification-added', () => this._scheduleTrim()));
    }

    _scheduleTrim() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            const notifications = Main.messageTray.getSources().flatMap(source => source.notifications);
            notifications.sort((a, b) => b.datetime.compare(a.datetime));
            for (const notification of notifications.slice(10))
                notification.destroy(NotificationDestroyedReason.EXPIRED);
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._list.disconnect(this._messageAdded);
        this._list.remove_style_class_name('compact-notifications');
        for (const [message, saved] of this._messages) {
            message.disconnect(saved.destroy);
            if (saved.titleParent) {
                message.titleLabel.get_parent().remove_child(message.titleLabel);
                saved.titleParent.insert_child_at_index(message.titleLabel, 0);
                saved.sourceTitle.visible = saved.sourceVisible;
            }
            if (!saved.expanded)
                message.unexpand(false);
        }
        this._messages.clear();
        this._list = null;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        Main.messageTray.disconnect(this._added);
        Main.messageTray.disconnect(this._removed);
        for (const [source, id] of this._sources)
            source.disconnect(id);
        this._sources.clear();
    }
}
