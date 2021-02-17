for(var phrase of phrases) {

    if(!phrase.isIndexSearchWorthy()) {
        continue;
    }

    var indexResults = index.searchPhrase(phrase);

    if(indexResults) {
        phrase.results = indexResults;
    }
    else if(phrase.isWebSearchWorthy()) {
        var webSearchResults = webSearch(phrase);
        for(var webSearchResult of webSearchResults) {
            var document = crawl(webSearchResult.url);
            index.indexDocument(document.id, document.meta, document.text);
        }
    }
}