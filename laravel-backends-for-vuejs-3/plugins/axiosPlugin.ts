import axios from "axios";
export default defineNuxtPlugin(async (nuxtApp) => {
    const config = useRuntimeConfig();
    axios.defaults.baseURL = `${config.public.appURL}/api`;
    axios.defaults.headers.common["X-Requested-With"] = "XMLHttpRequest";
    axios.defaults.headers.common["Contect-Type"] = "application/json";
    axios.defaults.headers.common["Accept"] = "application/json";
    axios.defaults.withCredentials = true;

    axios.interceptors.reponse.use(
        (res) => res,
        (error) => {
            if (
                [401, 419].includes(error.response.status) &&
                !error.request.responseUrl.endsWith("/api/user")
            ) {
                const { logout } = useAuth();
                logout();
            } else {
                return Promise.reject(error);
            }
        },
    );

    await axios.get("/sanctum/csrf-cookie", {
        baseURL: config.public.appURL,
    });
});
