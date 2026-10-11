import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient } from "../src/background/api-client.js";

test("description evaluation forwards scraped listing details without image data", async () => {
	let requestUrl;
	let requestOptions;
	const client = createApiClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "session-token",
		fetchImpl: async (url, options) => {
			requestUrl = url;
			requestOptions = options;
			return { ok: true, json: async () => ({ classification: "indeterminate" }) };
		},
	});
	const listingDetails = {
		title: "Linen shirt pattern",
		price: "$8.00",
		instructions: "Print at 100%",
		attributes: "Sizes XS-XL",
	};

	await client.evaluateDescription("A sewing pattern description", listingDetails);

	assert.equal(requestUrl, "https://api.example.test/api/evaluate-description");
	assert.deepEqual(JSON.parse(requestOptions.body), {
		description: "A sewing pattern description",
		listingDetails,
	});
	assert.equal(requestOptions.headers.Authorization, "Bearer session-token");
	assert.equal(requestOptions.body.includes("imageData"), false);
});

test("review evaluation sends the scraper payload without image bytes", async () => {
	let requestUrl;
	let requestOptions;
	const client = createApiClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "session-token",
		fetchImpl: async (url, options) => {
			requestUrl = url;
			requestOptions = options;
			return { ok: true, json: async () => ({ review_helpfulness_score: 85 }) };
		},
	});

	test("listing score lookup includes the current seller username", async () => {
		let requestUrl;
		const client = createApiClient({
			baseUrl: "https://api.example.test",
			getToken: async () => null,
			fetchImpl: async (url) => {
				requestUrl = url;
				return { ok: true, json: async () => ({ score: {} }) };
			},
		});

		test("trusted creator lookup is independent of a listing ID", async () => {
			let requestUrl;
			const client = createApiClient({
				baseUrl: "https://api.example.test",
				getToken: async () => null,
				fetchImpl: async (url) => {
					requestUrl = url;
					return {
						ok: true,
						json: async () => ({
							checked: true,
							username: "SoftpawVintage",
							trustedCreatorScore: 1,
						}),
					};
				},
			});

			const result = await client.getTrustedCreator("SoftpawVintage");

			assert.equal(
				requestUrl,
				"https://api.example.test/api/scores/trusted-creator/SoftpawVintage",
			);
			assert.equal(result.trustedCreatorScore, 1);
		});

		await client.getListingScore("etsy", "4383107558", "SoftpawVintage");

		assert.equal(
			requestUrl,
			"https://api.example.test/api/scores/etsy/4383107558?username=SoftpawVintage",
		);
	});
	const reviewsAndImages = {
		ratings: "5 stars from 12 reviews",
		reviews: [{ text: "Clear instructions and easy to sew", rating: "5 stars" }],
		images: [{ url: "https://i.etsystatic.com/listing.jpg", alt: "Finished dress" }],
		reviewImages: [{ url: "https://i.etsystatic.com/review.jpg", alt: "Customer make" }],
	};

	await client.evaluateReviews(reviewsAndImages);

	assert.equal(requestUrl, "https://api.example.test/api/reviews/evaluate");
	assert.deepEqual(JSON.parse(requestOptions.body), { reviewsAndImages });
	assert.equal(requestOptions.headers.Authorization, "Bearer session-token");
	assert.equal(requestOptions.body.includes("imageData"), false);
});