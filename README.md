# Search and Data Layer

> **Origin:** Selected code from shipped production software

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat&logo=mongodb&logoColor=white)
![Elasticsearch](https://img.shields.io/badge/Elasticsearch-005571?style=flat&logo=elasticsearch&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)

Selected code from an educational resource platform. Features Elasticsearch-powered document discovery and MongoDB bulk write optimizations for batch operations.

## Tech Stack

TypeScript, Node.js, Express, MongoDB, Mongoose, Elasticsearch

## What's Inside

| Folder                                                                 | What It Shows                                                                      |
| :--------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| [elasticsearch-resource-discovery](./elasticsearch-resource-discovery) | Multi-field fuzzy search with relevance scoring, faceted filtering, and highlights |
| [bulk-write-optimization](./bulk-write-optimization)                   | Replacing N sequential `save()` calls with a single MongoDB `bulkWrite`            |

Each folder has its own README with problem, solution, and design decisions.