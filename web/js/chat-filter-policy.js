export function matchesChatFilter(searchableText,query){
  return !query || searchableText.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru"));
}
