# Classical Music Streaming App

We're building a streaming site optimized for classical music that uses spotify as the backend.

It uses NextJS on Vercel for frontend and edge api routes, with Turso Cloud (built on libSQL) as the DB. I aim to minimize the user data we store to the required better-auth tables. The main purpose of the DB is to store classical music metadata.

## Planned Features

* short term
    * understanding of additional metadata, and ability to search & navigate by these
        * catalog sections
        * works identified via catalog numbers, and opus
        * movements
        * recordings
        * nicknames ("Moonlight sonata")
    * Liked songs should be the home page. grouped by catalog number and recording
    * support users who only mark specific movements as 'liked' instead of the whole work
    * sort recordings by spotify popularity field
* long term
    * music discovery features - not sure how yet
    * sheet music integration - IMSLP, musescore

## Use cases

When first opening the app, we open the user's liked songs, and match all spotify track IDs to work+recording.
The tracks that are unmatched will be hidden. The user can see this list separately and submit missing tracks to the matching service. This should be possible for any playlist

The user should be able to click on a track's catalog number to see other recordings, sorted by popularity. Movements in a recording are always displayed together.

The user should be able to click on a track's composer to see popular works.

The user should be able to search for composer or work.