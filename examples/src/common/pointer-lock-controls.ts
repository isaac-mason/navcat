import type { Camera, WebGPURenderer } from 'three/webgpu';

export const createPointerLockControls = (renderer: WebGPURenderer, camera: Camera) => {
    const state = {
        isPointerLocked: false,
        // rotation around y
        yaw: 0,
        // rotation around x (clamped)
        pitch: 0,
    };

    renderer.domElement.tabIndex = 0;
    renderer.domElement.style.outline = 'none';

    const updateCursorForPointerLock = () => {
        // hide cursor while pointer locked
        if (state.isPointerLocked) {
            renderer.domElement.style.cursor = 'none';
        } else {
            renderer.domElement.style.cursor = 'auto';
        }
    };

    const onClick = () => {
        renderer.domElement.focus();
        renderer.domElement.requestPointerLock();
    };

    const onPointerLockChange = () => {
        state.isPointerLocked = document.pointerLockElement === renderer.domElement;
        updateCursorForPointerLock();
    };

    const onMouseMove = (event: MouseEvent) => {
        if (!state.isPointerLocked) return;

        const movementX = event.movementX || 0;
        const movementY = event.movementY || 0;

        const sensitivity = 0.0025;
        state.yaw -= movementX * sensitivity;
        state.pitch -= movementY * sensitivity;

        // clamp pitch to avoid flipping
        const maxPitch = Math.PI / 2 - 0.01;
        if (state.pitch > maxPitch) state.pitch = maxPitch;
        if (state.pitch < -maxPitch) state.pitch = -maxPitch;

        // apply rotation to camera
        camera.rotation.set(state.pitch, state.yaw, 0, 'ZYX');
    };

    const onPointerLockError = (ev: Event) => {
        console.warn('Pointer lock error', ev);
    };

    // setup listeners
    renderer.domElement.addEventListener('click', onClick);
    document.addEventListener('pointerlockerror', onPointerLockError);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);

    // dispose logic
    const dispose = () => {
        renderer.domElement.removeEventListener('click', onClick);
        document.removeEventListener('pointerlockerror', onPointerLockError);
        document.removeEventListener('pointerlockchange', onPointerLockChange);
        document.removeEventListener('mousemove', onMouseMove);
    };

    return {
        state,
        dispose,
    };
};
