# Public-site portrait asset provenance

The twelve files below are the only portrait binaries approved for the static `site/` surface. They are AI-generated creative historical interpretations, not authentic portraits, endorsements, or Official Catalog admission. Public-site approval does not admit these assets to runtime packs, installers, or catalog distribution.

The authoritative workshop record remains `design/brand-explorations/backstage-electric/assets/portraits/provenance.json`. Originals and generation prompt metadata remain outside `site/` and are not published as web assets.

| Subject | Public asset | SHA-256 | Bytes | Dimensions | Source trace |
|---|---|---|---:|---:|---|
| Ada Lovelace | `site/assets/portraits/ada-lovelace.webp` | `daa916a330fde6c45e6998e7cd447c205b71a89e28ef2e0ff890679f3566a5e2` | 68994 | 840×1200 | Everstone `74d3578ef19957763047ad1ac22e062955728069` |
| Benjamin Franklin | `site/assets/portraits/benjamin-franklin.webp` | `16951ccd809df29121a3417f344d4656320aef071a6cdf69138c89c9ca49e7c0` | 81188 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Elizabeth I | `site/assets/portraits/elizabeth-i.webp` | `4436884480fe701940d8c9bd695940bc238e99ab71c65eacd9ba55fc4c77220c` | 207016 | 840×1200 | Everstone `bfc5b7f263f2878fcfeb3ef5a86d0c6f88049d1e` |
| Frederick Douglass | `site/assets/portraits/frederick-douglass.webp` | `e445dd92b3c36e4dff5bc920b408bfc239fabfe6f6ad60d0e22e4a4b93892b2b` | 65726 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Galileo Galilei | `site/assets/portraits/galileo-galilei.webp` | `81c1826e479b4b8b6357e69da3bd9142c34f7f47a8742b8386ce4b78b3603605` | 68780 | 840×1200 | Everstone `74d3578ef19957763047ad1ac22e062955728069` |
| George Washington | `site/assets/portraits/george-washington.webp` | `3883588e3ac035deed560893b1ddc1bca34c356c197c0094f179365d4b7a3a03` | 54986 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Isaac Newton | `site/assets/portraits/isaac-newton.webp` | `b666032239adf370bfb187b612506466fabfa6d6d3272179d3055ef236c57466` | 123060 | 840×1200 | Everstone `bfc5b7f263f2878fcfeb3ef5a86d0c6f88049d1e` |
| Jane Austen | `site/assets/portraits/jane-austen.webp` | `abf73e727337eb88b99dfbe2f318bced75e2ce9ef34689e96dd26758879345ea` | 96626 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Leonardo da Vinci | `site/assets/portraits/leonardo-da-vinci.webp` | `6340c0f43e05e46175bfaad85f200d4e8cd1be2754cac3f2a3843df294842acd` | 105226 | 840×1200 | Everstone `74d3578ef19957763047ad1ac22e062955728069` |
| Mary Shelley | `site/assets/portraits/mary-shelley.webp` | `6030a58352b00b3fea02b7e950d2a58fa464c51efbdd453933e68312486a633f` | 66174 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Nicolaus Copernicus | `site/assets/portraits/nicolaus-copernicus.webp` | `f7536c02c87c15fc238ca3b528bf4f17146cf814b3ffdbd486094948af1ebf6e` | 67110 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |
| Thomas Jefferson | `site/assets/portraits/thomas-jefferson.webp` | `1af3d4d7f72dc0f5d94f0f889bd14fca3a6c737c071c68e521580a4178b4fd06` | 55880 | 768×1024 | FAL.ai / GPT Image 2 generation record `180cca3cdce401c23e561fd99fd4eebee67e1749ed08033136a262d88535c38c` |

Every public asset hash is enforced by `site/scripts/validate.py`; any byte change fails the static release gate until the reviewed digest is deliberately updated.
