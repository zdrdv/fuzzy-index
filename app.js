(async () => {

    const Index = require('./Index.class.js');
    const index = new Index('mytestset');

    // await index.indexSampleDocs(true);
    // await index.indexSampleDocs2(false);

    // const queries = require('./sentences.js');
    // for(const query of queries) {
    //     console.time('search');
    //     await index.searchPhrase(query);
    //     console.timeEnd('search');
    // }
    // process.exit(0);

    const query = 'stock market volatility has been totally wild lately';

    console.time('search');
    var searchResults = await index.searchPhrase(query);
    console.timeEnd('search');

    console.log('\nsearch results for: \n\n"%s"\n\n', query);

    if(searchResults.length) {
        for(var result of searchResults) {
            let snippet = await index.getSnippet(result.doc_id, result.offset_start, result.offset_end, 10);
            console.log('doc_id: %s - score: %s% - offset: %s\n', result.doc_id, result.score, result.offset_start);
            console.log(snippet);
            console.log(snippet.text);
            console.log(snippet.text.substr(snippet.match_start, (snippet.match_end - snippet.match_start)));
            console.log('\n-------------------------------------------------------------------------\n');
        }
    }
    else {
        console.log('no results...');
    }

    // var tokenObjects = index.tokenize('The following table shows configuration and information for serving');
    // var ngramObjects = index.ngrams(tokenObjects);
    // console.log(ngramObjects);

    process.exit(0);

})();