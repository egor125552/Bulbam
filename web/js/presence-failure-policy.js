// A failed refresh cannot prove someone is online, but the last known visit
// is still valuable to the user and must not be discarded.
export function offlinePresenceAfterFailedRefresh(statuses){
  return statuses.map(status=>({...status,online:false}));
}
