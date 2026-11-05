export function takeRequestedChat(locationUrl,replaceAddress){
  const url=new URL(locationUrl);
  // Calls own navigation while recovery / active-call query parameters exist.
  if(url.searchParams.has("call"))return null;
  const id=url.searchParams.get("chat");
  if(!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))return null;
  url.searchParams.delete("chat");
  replaceAddress(url.pathname+url.search+url.hash);
  return id;
}
