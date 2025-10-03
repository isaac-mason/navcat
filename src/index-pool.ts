export const createIndexPool = () => {
    return {
        free: [] as number[],
        counter: -1,
    };
};

export type IndexPool = ReturnType<typeof createIndexPool>;

export const requestIndex = (indexPool: IndexPool): number => {
    if (indexPool.free.length > 0) {
        return indexPool.free.pop()!;
    }

    return indexPool.counter++;
};

export const releaseIndex = (indexPool: IndexPool, index: number) => {
    indexPool.free.push(index);
};
