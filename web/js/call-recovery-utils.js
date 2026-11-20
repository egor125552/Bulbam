// ICE candidates can be delivered ahead of their SDP offer because trickle
// signaling is asynchronous. Do not discard candidates for a newer inbound
// negotiation before the matching offer has arrived.
export function classifyIceCandidate(candidateGeneration, expectedGeneration, canReceiveOffers) {
  if (!candidateGeneration || !expectedGeneration || candidateGeneration === expectedGeneration) {
    return "apply";
  }
  return canReceiveOffers ? "queue" : "ignore";
}
