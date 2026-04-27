import type { CalendarEvent } from '@shared/types';

// Returns the CSS modifier class for an unaccepted RSVP, or null when the
// event was accepted (or has no attendee record). Keeping the mapping in one
// place means every renderer (cells, ribbons, agenda, popover) lights up the
// same way.
export function rsvpClass(e: CalendarEvent): string | null {
  switch (e.rsvp) {
    case 'needsAction': return 'rsvp-needsaction';
    case 'tentative': return 'rsvp-tentative';
    case 'declined': return 'rsvp-declined';
    default: return null;
  }
}

export function rsvpLabel(rsvp: CalendarEvent['rsvp']): string | null {
  switch (rsvp) {
    case 'needsAction': return 'Needs response';
    case 'tentative': return 'Tentative';
    case 'declined': return 'Declined';
    default: return null;
  }
}
