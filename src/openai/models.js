import { toOpenAIModel } from '../opencode/catalog.js';

/** GET /v1/models and GET /v1/models/{id} (ids may contain a slash). */
export function modelsHandlers({ catalog }) {
    const list = async (req, res) => {
        const models = await catalog.list();
        res.json({ object: 'list', data: models.map(toOpenAIModel) });
    };

    const retrieve = async (req, res) => {
        const raw = req.params.id;
        const id = Array.isArray(raw) ? raw.join('/') : String(raw);
        res.json(toOpenAIModel(await catalog.resolve(id)));
    };

    return { list, retrieve };
}
