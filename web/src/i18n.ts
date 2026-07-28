/**
 * All user-facing copy lives here, keyed by string id. Today there is one
 * locale; adding another means adding a second dictionary and picking it in
 * `messages` — no component changes needed.
 */

const en = {
  'app.name': 'BetSend',
  'app.tagline': 'Send files to people in this office.',

  'nav.send': 'Send',
  'nav.inbox': 'Inbox',
  'nav.sent': 'Sent',
  'nav.admin': 'Admin',
  'nav.theme.light': 'Switch to light mode',
  'nav.theme.dark': 'Switch to dark mode',
  'nav.switchUser': 'Not you? Switch user',
  'nav.offline': 'Reconnecting to the server…',

  'onboarding.title': 'Who are you?',
  'onboarding.subtitleOpen': 'Type your name the way it appears on the staff list.',
  'onboarding.subtitleList': 'Pick your name from the list.',
  'onboarding.placeholder': 'e.g. {example}',
  'onboarding.continue': 'Continue',
  'onboarding.search': 'Search for your name',
  'onboarding.noMatches': 'No names match “{query}”.',
  'onboarding.emptyList': 'Nobody has been added yet. Ask whoever runs BetSend to import the staff list.',
  'onboarding.hint': 'One initial, a dot, then your last name — like {example}.',
  'onboarding.trust': 'No password needed. This only works inside the office network.',

  'send.title': 'Send files',
  'send.dropTitle': 'Drop files here',
  'send.dropSubtitle': 'or click to choose — any type, any size',
  'send.dropActive': 'Release to add',
  'send.addMore': 'Add more files',
  'send.clearFiles': 'Remove all',
  'send.filesTitle': '{count} file ready|{count} files ready',
  'send.to': 'Send to',
  'send.searchPeople': 'Search people…',
  'send.selectAll': 'Select all',
  'send.clearSelection': 'Clear',
  'send.noPeople': 'Nobody is in the directory yet.',
  'send.noMatches': 'No one matches “{query}”.',
  'send.note': 'Note (optional)',
  'send.notePlaceholder': 'Add a short message…',
  'send.submit': 'Send',
  'send.submitting': 'Sending…',
  'send.cancel': 'Cancel',
  'send.cancelAll': 'Cancel upload',
  'send.needFiles': 'Add at least one file.',
  'send.needRecipients': 'Choose at least one person.',
  'send.success': 'Sent to {names}.',
  'send.uploading': 'Uploading {done} of {total}',
  'send.speed': '{speed}/s',
  'send.remaining': '{time} left',
  'send.retry': 'Try again',
  'send.tooBig': '{name} is larger than this server allows ({limit}).',
  'send.expiresIn': 'Recipients have {hours} hours to download.',
  'send.online': 'online',
  'send.offlineOk': 'People do not need to be online — files wait for them.',

  'inbox.title': 'Inbox',
  'inbox.empty': 'Nothing here yet',
  'inbox.emptyHint': 'When somebody sends you files, they show up here right away.',
  'inbox.from': 'From {name}',
  'inbox.downloadAll': 'Download all ({count})',
  'inbox.downloadZip': 'Download all as zip',
  'inbox.download': 'Download',
  'inbox.downloaded': 'Downloaded',
  'inbox.new': 'New',
  'inbox.expiresIn': 'Expires in {time}',
  'inbox.expiringSoon': 'Expires in {time}',
  'inbox.gone': 'These files are no longer available.',

  'sent.title': 'Sent',
  'sent.empty': 'You have not sent anything yet',
  'sent.emptyHint': 'Head to Send, drop some files and pick who should get them.',
  'sent.to': 'To {count} person|To {count} people',
  'sent.waiting': 'Waiting',
  'sent.picked': 'Downloaded',
  'sent.opened': 'Opened',
  'sent.revoke': 'Cancel transfer',
  'sent.revokeConfirm': 'Cancel this transfer?',
  'sent.revokeBody': 'The files will be deleted and recipients who have not downloaded yet will lose access.',
  'sent.revoked': 'Transfer cancelled.',
  'sent.stateRevoked': 'Cancelled',
  'sent.stateExpired': 'Expired',
  'sent.stateCompleted': 'Everyone downloaded',
  'sent.progress': '{done} of {total} downloaded',

  'admin.title': 'Admin',
  'admin.tokenPrompt': 'Enter the admin token',
  'admin.tokenHint': 'This is the ADMIN_TOKEN from the server configuration.',
  'admin.tokenBad': 'That token is not correct.',
  'admin.unlock': 'Unlock',
  'admin.lock': 'Lock admin',
  'admin.storage': 'Storage',
  'admin.usedByTransfers': 'Used by transfers',
  'admin.diskFree': 'Free on disk',
  'admin.diskTotal': 'Disk size',
  'admin.directory': 'Storage directory',
  'admin.people': 'People',
  'admin.peopleOnline': '{online} of {total} online',
  'admin.activeTransfers': 'Active transfers',
  'admin.settings': 'Settings',
  'admin.retention': 'Keep files for (hours)',
  'admin.maxSize': 'Maximum file size',
  'admin.maxSizeHint': 'Leave at 0 for no limit.',
  'admin.deleteAfter': 'Delete as soon as everyone has downloaded',
  'admin.registrationMode': 'Who can pick a name',
  'admin.modeOpen': 'Anyone can type their own name',
  'admin.modeList': 'Only names on the imported list',
  'admin.save': 'Save settings',
  'admin.saved': 'Settings saved.',
  'admin.restartNeeded': 'Saved. The storage directory only changes after a server restart.',
  'admin.users': 'User list',
  'admin.importTitle': 'Import people',
  'admin.importHint': 'One name per line, or CSV with the name in the first column.',
  'admin.import': 'Import',
  'admin.imported': 'Added {added}, already present {existing}.',
  'admin.importInvalid': '{count} line(s) skipped — they did not look like {example}.',
  'admin.removeUser': 'Remove',
  'admin.removeConfirm': 'Remove {name}?',
  'admin.removeBody': 'They disappear from the directory. Transfers already sent are unaffected.',
  'admin.transfers': 'All transfers',
  'admin.deleteTransfer': 'Delete',
  'admin.deleteConfirm': 'Delete this transfer?',
  'admin.deleteBody': 'The files are removed from the server immediately.',
  'admin.cleanup': 'Run cleanup now',
  'admin.cleanupDone': 'Cleanup finished — {blobs} file(s) removed, {freed} freed.',
  'admin.noTransfers': 'No transfers on the server.',
  'admin.noUsers': 'No people yet. Import a list to get started.',

  'notify.prompt': 'Get a desktop alert when files arrive, even in another tab.',
  'notify.enable': 'Turn on',
  'notify.title': 'New files from {name}',
  'notify.body': '{count} file|{count} files',
  'notify.dismiss': 'No thanks',

  'toast.newTransfer': '{name} sent you {count} file|{name} sent you {count} files',
  'toast.downloaded': '{name} downloaded your files.',
  'toast.revoked': '{name} cancelled a transfer.',
  'toast.expired': 'A transfer in your inbox expired.',

  'error.generic': 'Something went wrong. Please try again.',
  'error.offline': 'Cannot reach the server. Check that it is still running.',
  'error.retry': 'Try again',
  'error.loading': 'Loading…',

  'time.days': '{n}d',
  'time.hours': '{n}h',
  'time.minutes': '{n}m',
  'time.seconds': '{n}s',
  'time.justNow': 'just now',
  'time.expired': 'expired',
} as const;

export type MessageKey = keyof typeof en;

const messages: Record<string, Record<string, string>> = { en };
const locale = 'en';

/**
 * Look up a string and fill in `{placeholders}`.
 * A message containing `|` is a plural pair: `singular|plural`, chosen by the
 * `count` parameter.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = messages[locale][key] ?? key;

  if (text.includes('|')) {
    const [one, many] = text.split('|');
    text = Number(params?.count) === 1 ? one : many;
  }

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
