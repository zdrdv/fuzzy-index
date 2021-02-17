const Redis = require('ioredis');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
const lodash = require('lodash');
const XXH = require('xxhashjs');

class Index {
    constructor(setName) {
        this.redis = new Redis();;
        this.ngramSize = 3;
        this.zsetName = setName;
    }
    tokenize(text) {
        text = text.toLowerCase();
        var tokens = tokenizer.tokenize(text);
        var lastOffset = 0;
        var objs = [];
        for (var token of tokens) {
            var offset = text.indexOf(token, lastOffset);
            lastOffset = offset + token.length;
            objs.push({
                text: token,
                length: token.length,
                offset: offset
            });
        }
        return objs;
    }
    ngrams(tokenObjects) {
        const maxTokenLength = 4;
        var ngrams = [];
        for (var i = 0; i <= (tokenObjects.length - this.ngramSize); ++i) {
            var ngramTokenObjects = tokenObjects.slice(i, i + this.ngramSize);
            var ngramText = ngramTokenObjects.map(obj => obj.text.substr(0, maxTokenLength)).join(' ');
            var ngramId = XXH.h32(ngramText, 0xABCD).toString(10);
            var firstToken = lodash.first(ngramTokenObjects);
            var lastToken = lodash.last(ngramTokenObjects);
            var offsetEnd = lastToken.offset + lastToken.length;
            ngrams.push({
                text: ngramText,
                id: ngramId,
                offset: firstToken.offset,
                length: offsetEnd - firstToken.offset
            });
        }
        return ngrams;
    }
    async indexDocument(id, meta, text) {
        var tokens = this.tokenize(text);
        var ngrams = this.ngrams(tokens);

        // index doc ngrams
        const multiInsert = ngrams.map(ngram => {
            // entry 'score' is the unique integer ID of the ngram text
            // entry 'value' is concatenation of doc_id + ngram offset + ngram length
            return ['zadd', this.zsetName, ngram.id, `${id}-${ngram.offset}-${ngram.length}`];
        });

        // insert doc text & meta
        var docInsert = ['hmset', `doc_${id}`, 'text', text];
        if(Object.keys(meta).length) {
            for(const key of Object.keys(meta)) {
                docInsert.push(key);
                docInsert.push(meta[key]);
            }
        }

        // add doc to transaction payload
        multiInsert.push(docInsert);

        return await this.redis.multi(multiInsert).exec();
    }
    async searchPhrase(text) {
        var tokens = this.tokenize(text);
        var ngrams = this.ngrams(tokens);
        var uniqueNgrams = lodash.uniqBy(ngrams, 'id');
        var multiQuery = uniqueNgrams.map(ngram => ['zrangebyscore', this.zsetName, ngram.id, ngram.id]);
        var zranges = await this.redis.multi(multiQuery).exec();

        // console.log(zranges);

        var results = zranges
            .map((resp, i) => {
                if(!resp[1].length) {
                    return null;
                }
                return resp[1].map(str => {
                    let parts = str.split('-');
                    let offset = parseInt(parts[1]);
                    return {
                        ngram: uniqueNgrams[i].text,
                        ngram_id: uniqueNgrams[i].id,
                        doc_id: parts[0],
                        offset_start: offset,
                        offset_end: offset + parseInt(parts[2])
                    }
                });
            })
            .filter(a => a);

        if(results.length === 0) {
            return [];
        }

        var orderedHits = lodash.flatten(results).sort((a, b) => {
            if (a.doc_id !== b.doc_id) {
                return a.doc_id - b.doc_id;
            }
            return a.offset_start - b.offset_start;
        });

        // console.log(orderedHits);

        // group sequences from same doc ID
        var seqHits = [
            [orderedHits[0]]
        ];

        const maxSeqGapLength = 30;
        for (var s = 1; s < orderedHits.length; ++s) {
            let last = lodash.last(lodash.last(seqHits));
            let curr = orderedHits[s];
            // if same doc AND are neighboring hits (allows for gap in hits for fuzzy support)
            if ((last.doc_id === curr.doc_id) && ((last.offset_end > curr.offset_start) || (curr.offset_start - last.offset_end < maxSeqGapLength)) && (last.offset_end < curr.offset_end)) {
                lodash.last(seqHits).push(curr);
            }
            else {
                seqHits.push([curr]);
            }
        }

        // console.log(orderedHits);
        // console.log(seqHits);

        // convert seq hits into single hit object
        var hits = seqHits
            .map(hitArr => {
                var first = lodash.first(hitArr);
                var last = lodash.last(hitArr);
                return {
                    doc_id: first.doc_id,
                    score: parseFloat(((hitArr.length / ngrams.length) * 100).toFixed(2)),
                    offset_start: first.offset_start,
                    offset_end: last.offset_end
                }
            })
            .sort((a, b) => b.score - a.score);

        return hits;
    }
    async getSnippet(docId, offsetStart, offsetEnd, contextLength = 30) {

        /*
            returns object with text snippet + trailing context text before & after
            and offset data relative to the snippet 

            Example response:

            {
                text: 'e crisis, stock market volatility has been absolutel',
                match_start: 10,
                match_end: 42
            }
        */

        // get document text
        var text = await this.redis.hget(`doc_${docId}`, 'text');

        // starting offset of the snippet text accounting for context size
        var snippetOffsetStart = Math.max(offsetStart - contextLength, 0);

        // length of text before (may be less than desired, e.g. if match is near the beginning of document)
        var contextLeftLength = offsetStart - snippetOffsetStart;

        // length of just the matched text
        var matchLength = offsetEnd - offsetStart;

        // total length of snippet text of match + context before & after
        var snippetLength = matchLength + contextLeftLength + contextLength;

        // snippet text with before/after context text
        var snippetText = text.substr(snippetOffsetStart, snippetLength);

        return {
            text: snippetText,
            match_start: contextLeftLength,
            match_end: contextLeftLength + matchLength
        }
    }
    async indexSampleDocs(flush = true) {
        if(flush) {
            await this.redis.flushdb();
        }
        const documents = [
            {
                id: 219382,
                text: `The following table shows configuration and results information for serving the search app using App Engine The load test was performed using the ab - Apache HTTP server benchmarking tool for 180 seconds.`
            },
            {
                id: 19382,
                text: `The following table shows configuration and information to serving the search app using App Engine The load test was  HTTP server benchmarking tools a for 180 seconds. information to serving the search app using App Engine to date`
            },
            {
                id: 4043922,
                text: `The generative network generates candidates while the discriminative network evaluates them.[1] The contest operates in terms of data distributions. Typically, the generative network learns to map from a latent space to a data distribution of interest, while the discriminative network distinguishes candidates produced by the generator from the true data distribution. The generative network's training objective is to increase the error rate of the discriminative network (i.e., "fool" the discriminator network by producing novel candidates that the discriminator thinks are not synthesized (are part of the true data distribution)).[1][6]

                A known dataset serves as the initial training data for the discriminator. Training it involves presenting it with samples from the training dataset, until it achieves acceptable accuracy. The generator trains based on whether it succeeds in fooling the discriminator. Typically the generator is seeded with randomized input that is sampled from a predefined latent space (e.g. a multivariate normal distribution). Thereafter, candidates synthesized by the generator are evaluated by the discriminator. Independent backpropagation procedures are applied to both networks so that the generator produces better images, while the discriminator becomes more skilled at flagging synthetic images.[7] The generator is typically a deconvolutional neural network, and the discriminator is a convolutional neural network.
                
                GANs often suffer from a "mode collapse" where they fail to generalize properly, missing entire modes from the input data. For example, a GAN trained on the MNIST dataset containing many samples of each digit, might nevertheless timidly omit a subset of the digits from its output. Some researchers perceive the root problem to be a weak discriminative network that fails to notice the pattern of omission, while others assign blame to a bad choice of objective function. Many solutions have been proposed.[8]
                
                `
            },
            {
                id: 4042,
                text: `In the wake of the COVID-19 pandemic, global markets have experienced a meltdown. Some countries closed their borders and enforced strict quarantines, and around the world, millions of businesses large and small, saw sales and profits vanish, contributing to a spike in unemployment. In the US, despite a $2 trillion economic stimulus package and government funding for emergency business loans, White House advisors project a jobless rate of 16% or more for April.

                In response to the crisis, stock market volatility has been absolutely wild, with major benchmarks leaping and diving 5% or more from day to day. (When stocks deviate substantially from their average prices, that means volatility is high.) But even with everything that’s going on, for potential investors, it’s vital to think about this volatility with a clear head and consider how it might affect their plans.`
            }
        ];
        console.time('index');
        for(var document of documents) {
            await this.indexDocument(document.id, { url: 'lksjf.com' }, document.text);
        }
        console.timeEnd('index');
    }
    async indexSampleDocs2(flush = true) {
        if(flush) {
            await this.redis.flushdb();
        }
        const documents = require('./sentences.js').map(str => {
            return {
                text: str,
                id: XXH.h32(str, 0xABCD).toString(10)
            }
        });
        console.time('index');
        for(var document of documents) {
            await this.indexDocument(document.id, { url: 'lksjf.com' }, document.text);
        }
        console.timeEnd('index');
    }
}

module.exports = Index;