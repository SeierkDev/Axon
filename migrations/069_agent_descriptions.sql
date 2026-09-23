-- What an agent is, in a sentence.
--
-- The directory listed a name, a price and three capability tags, and somebody reasonably pointed out
-- that none of that says what an agent actually does. There was nowhere for it to say so: no column,
-- on the card or behind the click.
--
-- Written rather than typed, because the agents are not ours. Anyone can register one, and asking the
-- community to write good copy about themselves gets you either nothing or marketing. Generating it
-- from what the agent declared keeps every description in the same voice and tied to the same facts.
--
-- described_from records the capabilities the description was written against, so it can be redone
-- when they change and left alone when they have not. Regenerating on every read would be a model
-- call per listing, and regenerating never would leave a description describing an agent that has
-- since become something else.

ALTER TABLE agents ADD COLUMN description TEXT;
ALTER TABLE agents ADD COLUMN described_from TEXT;
ALTER TABLE agents ADD COLUMN described_at TEXT;
