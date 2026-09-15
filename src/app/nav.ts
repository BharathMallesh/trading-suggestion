// Route identifiers for the Luna shell. 'home' and 'chat' are fully built;
// the rest are navigable placeholders we flesh out screen by screen.
export type Page =
  | 'home'
  | 'chat'
  | 'messages'
  | 'personality'
  | 'schedules'
  | 'superpowers'
  | 'memory'
  | 'library'
  | 'workspace'
  | 'contacts'
  | 'channels';

export const PAGE_TITLE: Record<Page, string> = {
  home: 'Home',
  chat: 'New Chat',
  messages: 'Messages',
  personality: 'Shape my personality',
  schedules: 'Schedules',
  superpowers: 'My Superpowers',
  memory: 'Memory',
  library: 'Library',
  workspace: 'Workspace',
  contacts: 'Contacts',
  channels: 'Channels',
};
