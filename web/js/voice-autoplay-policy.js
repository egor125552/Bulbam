export function shouldAutoPlayNextVoice(next,viewerUserId){
  return Boolean(next?.kind==="voice" && viewerUserId &&
    next.senderUserId!==viewerUserId && !next.completedAt);
}
