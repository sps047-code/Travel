import type { Trip } from './data/model';

// A small seed so the rewrite has real content to render. Times are canonical;
// durations are derived. Coordinates are correct (Rosslyn near Edinburgh!).
export const SEED_TRIP: Trip = {
  id: 'seed-scotland',
  title: 'Scotland',
  startDate: '2026-08-10',
  tripType: 'solo',
  travelers: ['London', 'Bella'],
  days: [
    {
      id: 'd-1',
      date: '2026-08-10',
      title: 'Rosslyn, Glenfinnan & Glencoe',
      destination: 'Scottish Highlands',
      tip: 'Leave Edinburgh early — the Jacobite steam train crosses Glenfinnan around 1:20 PM.',
      stops: [
        { id: 's-1', name: 'Rosslyn Chapel', type: 'sight',
          location: { lat: 55.8553, lng: -3.16, verified: true },
          startTime: '9:30AM', endTime: '10:30AM',
          notes: 'Extraordinary carved stonework — the Apprentice Pillar.' },
        { id: 's-2', name: 'Glenfinnan Viaduct', type: 'hike',
          location: { lat: 56.8758, lng: -5.431, verified: true },
          startTime: '1:20PM', endTime: '2:20PM',
          notes: 'Walk up from the car park on the B8008 for the classic view.' },
        { id: 's-3', name: 'Glencoe', type: 'hike',
          location: { lat: 56.6779, lng: -5.0974, verified: true },
          startTime: '4:00PM', endTime: '6:00PM',
          notes: 'The Three Sisters — dark, brooding, unforgettable.' },
        { id: 's-4', name: 'Hub by Premier Inn Edinburgh', type: 'lodging',
          location: { lat: 55.9525, lng: -3.1986, verified: true },
          startTime: '8:30PM', endTime: '9:00PM' },
      ],
    },
    {
      id: 'd-2',
      date: '2026-08-11',
      title: 'Edinburgh Old Town',
      destination: 'Edinburgh',
      stops: [
        { id: 's-5', name: 'Edinburgh Castle', type: 'sight',
          location: { lat: 55.9486, lng: -3.1999, verified: true },
          startTime: '9:30AM', endTime: '11:30AM' },
        { id: 's-6', name: 'The Real Mary King’s Close', type: 'tour',
          location: { lat: 55.9497, lng: -3.1901, verified: true },
          startTime: '12:30PM', endTime: '1:30PM' },
        { id: 's-7', name: 'Dinner — Dishoom Edinburgh', type: 'food',
          location: { lat: 55.9512, lng: -3.1888, verified: true },
          startTime: '7:00PM', endTime: '8:30PM' },
        { id: 's-8', name: 'Hub by Premier Inn Edinburgh', type: 'lodging',
          location: { lat: 55.9525, lng: -3.1986, verified: true },
          startTime: '9:00PM', endTime: '9:30PM' },
      ],
    },
  ],
};
